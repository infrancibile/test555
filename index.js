// console-bot.js - versione aggiornata con fixes for !loop and /accounts chat logging
// - !click che clicca dove sta guardando senza girarsi
// - /connect chiede l'IGN e la prossima riga inserita in console sarà usata come username
// - !hand <n> seleziona lo slot hotbar n (1-9)
// - !compass esegue un right-click con l'item in mano (attiva l'item per ~150ms)
// - !gui mostra gli items nella GUI aperta (se presente) e poi chiede nome/n. Clicca lo slot scelto.
// - !loop aggiunto: ciclo ripetuto di /kits -> click slot 11 -> /sell -> shift items -> drop -> /pay -> wait 5m5s -> repeat
// - /accounts <n> aggiunto: crea n bot (default 5) su metamc.it e segue il flusso richiesto
// npm install mineflayer mineflayer-pathfinder minecraft-data vec3

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const mcDataLib = require('minecraft-data');
const vec3 = require('vec3');
const readline = require('readline');
const { randomInt } = require('crypto');

let bot = null;
let lastOptions = null;
let pendingConnect = null; // { host, port, version, suggestedUsername? }

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
});

/** Normalize text: remove color codes and non-alphanumeric (except spaces), return lowercase */
function normalizeText(x) {
  if (!x) return '';
  let s = (typeof x === 'object' && x.toString) ? x.toString() : String(x);
  // remove section sign color/format codes (§x)
  s = s.replace(/\u00A7[0-9A-FK-OR]/gi, '');
  // keep letters, numbers and spaces
  s = s.replace(/[^a-zA-Z0-9\s]/g, '');
  return s.trim().toLowerCase();
}

// ----------------- Create & attach bot -----------------
function createBot(opts) {
  if (bot) {
    console.log('A bot is already connected. Disconnect first or use /disconnect.');
    return;
  }
  lastOptions = Object.assign({}, opts);
  console.log(`Creating bot -> ${opts.username || 'unnamed'} @ ${opts.host}:${opts.port || 25565} (version ${opts.version || 'auto'})`);
  bot = mineflayer.createBot(opts);

  // load pathfinder plugin asap
  bot.loadPlugin(pathfinder);

  bot.once('login', () => {
    console.log('[BOT] Logged in as', bot.username);
    trySetupPathfinder();
  });
 
  bot.on('spawn', () => {
    console.log('[BOT] Spawned in world.');
    scanAndLogNPCs();
  });

  // High-level chat event (username, message)
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    console.log(`<${username}> ${message}`);
  });

  // Raw system messages (json)
  bot.on('message', (jsonMsg) => {
    try {
      const text = jsonMsg.toString();
      console.log('[MSG]', text);
    } catch (e) {
      console.log('[MSG] (unparsable)', jsonMsg);
    }
  });

  bot.on('kicked', (reason) => {
    console.log('[BOT] Kicked:', reason?.toString?.() || reason);
  });

  bot.on('end', (reason) => {
    console.log('[BOT] Disconnected.', reason || '');
    bot = null;
  });

  bot.on('error', (err) => {
    console.error('[BOT] Error:', err && err.message ? err.message : err);
  });

  if (bot._client && bot._client.on) {
    bot._client.on('packet', (packet, meta) => {
      if (!meta || !meta.name) return;
      const name = String(meta.name).toLowerCase();
      if (name.includes('transfer')) {
        const host = packet.address || packet.host || packet.serverAddress || packet.target || packet.server || packet.serverHost;
        const port = packet.port || packet.serverPort || packet.serverPort;
        console.log('[PACKET] Transfer packet received:', packet, 'meta:', meta);
        if (!host) {
          console.log('[TRANSFER] Packet had no host field; ignoring.');
          return;
        }
        const targetPort = (typeof port === 'number' && port > 0) ? port : 25565;
        console.log(`[TRANSFER] Attempting to follow transfer to ${host}:${targetPort}`);
        try {
          const newOpts = Object.assign({}, lastOptions, { host, port: targetPort });
          if (bot) { bot.end('Following transfer'); }
          setTimeout(() => {
            console.log('[TRANSFER] Reconnecting to transferred server...');
            createBot(newOpts);
          }, 500);
        } catch (e) {
          console.error('[TRANSFER] Failed to follow transfer:', e);
        }
      }
    });
  } else {
    console.warn('[WARN] Raw client not available — cannot listen for transfer packets.');
  }
}

// --- Pathfinding setup helper ---
function trySetupPathfinder() {
  if (!bot) return;
  try {
    const mcData = mcDataLib(bot.version);
    const defaultMove = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMove);
    console.log('[PATHFINDER] Movements set for version', bot.version);
  } catch (e) {
    console.warn('[PATHFINDER] Impossibile inizializzare Movements:', e.message || e);
  }
}

// ----------------- lista entità/NPC migliorata -----------------
function scanAndLogNPCs(verbose = true) {
  if (!bot) {
    if (verbose) console.log('Not connected.');
    return [];
  }
  const entities = bot.entities || {};
  const out = [];
  const myPos = bot.entity ? bot.entity.position : null;
  for (const idStr in entities) {
    const e = entities[idStr];
    if (!e) continue;
    const username = e.username || null;
    const displayName = (e.displayName && typeof e.displayName.toString === 'function') ? e.displayName.toString() : (e.nameTag && typeof e.nameTag.toString === 'function' ? e.nameTag.toString() : null);
    const rawDisplay = displayName || username || (`${e.type || 'entity'}#${e.id}`);
    let dist = '-';
    if (myPos && e.position) {
      try {
        dist = myPos.distanceTo(e.position).toFixed(02);
      } catch (err) { dist = '-'; }
    }
    out.push({
      id: Number(e.id),
      type: e.type || 'unknown',
      username: username,
      displayRaw: rawDisplay,
      displayClean: normalizeText(rawDisplay),
      pos: e.position ? { x: e.position.x, y: e.position.y, z: e.position.z } : null,
      distance: dist
    });
  }
  out.sort((a, b) => {
    if (a.distance === '-' || b.distance === '-') return 0;
    return Number(a.distance) - Number(b.distance);
  });
  if (verbose) {
    if (out.length === 0) {
      console.log('[NPC] Nessuna entità trovata.');
    } else {
      console.log('[NPC] Entità trovate (id | type | username | displayRaw | distance):');
      out.forEach(e => {
        console.log(` - ${e.id} | ${e.type} | ${e.username || '-'} | "${e.displayRaw}" | ${e.distance}`);
      });
    }
  }
  return out;
}

// ----------------- ricerca NPC migliorata -----------------
function findNPCByName(query) {
  if (!bot || !query) return null;
  query = String(query).trim();
  if (!query) return null;
  // se è numerico, cerca per id
  if (/^\d+$/.test(query)) {
    const id = Number(query);
    return bot.entities[id] || null;
  }
  const q = normalizeText(query);
  // prima cerca corrispondenza esatta username
  for (const idStr in bot.entities) {
    const e = bot.entities[idStr];
    if (!e) continue;
    if (e.username && normalizeText(e.username) === q) return e;
  }
  // poi cerca substring in username/displayName/nameTag
  for (const idStr in bot.entities) {
    const e = bot.entities[idStr];
    if (!e) continue;
    const username = e.username ? normalizeText(e.username) : '';
    let display = '';
    if (e.displayName && typeof e.displayName.toString === 'function') display = normalizeText(e.displayName.toString());
    else if (e.nameTag && typeof e.nameTag.toString === 'function') display = normalizeText(e.nameTag.toString());
    const combined = (username + ' ' + display).trim();
    if (combined && combined.includes(q)) return e;
  }
  return null;
}

// --- Vai verso NPC e left click (attack) ---
function goToNPCAndClick(nameOrEntity, clickType = 'left') {
  if (!bot) {
    console.log('Not connected.');
    return;
  }
  if (!bot.pathfinder) {
    console.log('Pathfinder non inizializzato.');
    return;
  }
  let target = null;
  if (typeof nameOrEntity === 'object' && nameOrEntity !== null && nameOrEntity.id) {
    target = nameOrEntity;
  } else {
    target = findNPCByName(String(nameOrEntity));
  }
  if (!target) {
    console.log(`[NPC] Nessun NPC trovato per "${nameOrEntity}". Usa !lista per vedere id/nomi disponibili.`);
    return;
  }
  const pos = target.position || target.entityPosition || (target.entity && target.entity.position) || null;
  if (!pos) {
    console.log('[NPC] NPC trovato ma senza posizione valida.');
    return;
  }
  console.log(`[NPC] Trovato NPC id:${target.id} – avvicinamento a (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`);
  const goal = new GoalNear(pos.x, pos.y, pos.z, 1.8);
  bot.pathfinder.setGoal(goal);

  const onReached = () => {
    console.log('[NPC] Raggiunto NPC, provo click:', clickType);
    try {
      // Qui usiamo i packet per non forzare il bot a guardare il bersaglio
      if (clickType === 'left') {
        sendAttackPacket(target);
      } else {
        // right click (interact)
        tryUseEntityPacket(target);
      }
    } catch (e) {
      console.log('[NPC] Errore durante il click:', e);
    } finally {
      try { bot.pathfinder.setGoal(null); } catch (e) {}
      cleanup();
    }
  };

  function tryUseEntityPacket(targetEntity) {
    if (!bot || !bot._client) return console.log('[NPC] Impossibile inviare packet use_entity (client non disponibile).');
    try {
      try {
        // modern-ish: mouse 1 = interact
        bot._client.write('use_entity', { target: targetEntity.id, mouse: 1 });
      } catch (_) {
        // fallback older shapes
        bot._client.write('use_entity', { target: targetEntity.id, type: 0 });
      }
    } catch (e) {
      console.log('[NPC] Fallback use_entity failed:', e);
      // ultimate fallback: swing arm
      if (typeof bot.swingArm === 'function') { bot.swingArm(); }
    }
  }

  function sendAttackPacket(targetEntity) {
    if (!bot || !bot._client) {
      console.log('[NPC] Impossibile inviare packet attack (client non disponibile).');
      // fallback: swing arm so at least something happens
      if (typeof bot.swingArm === 'function') bot.swingArm();
      return;
    }
    try {
      try {
        // modern-ish: mouse 0 = attack
        bot._client.write('use_entity', { target: targetEntity.id, mouse: 0 });
      } catch (_) {
        // fallback older shape: type 1 often means attack
        bot._client.write('use_entity', { target: targetEntity.id, type: 1 });
      }
      console.log(`[NPC] Attack packet inviato a entità id:${targetEntity.id}`);
    } catch (e) {
      console.log('[NPC] Attack packet failed:', e);
      if (typeof bot.swingArm === 'function') bot.swingArm();
    }
  }

  const onTimeout = () => {
    console.log('[NPC] Timeout nell\'avvicinamento all\'NPC, annullo.');
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    cleanup();
  };

  function cleanup() {
    bot.removeListener('goal_reached', onReached);
  }

  bot.once('goal_reached', onReached);
  setTimeout(onTimeout, 60000);
}

// ----------------- WALK TO COORDS -----------------
function walkToCoords(x, y, z, tolerance = 1.2) {
  if (!bot) return console.log('Not connected.');
  if (!bot.pathfinder) return console.log('Pathfinder non inizializzato.');
  if (!bot.entity) return console.log('Bot entity non disponibile.');
  x = Number(x); y = Number(y); z = Number(z);
  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
    return console.log('Usage: !coords x y z (numeri richiesti)');
  }
  console.log(`[COORDS] Cammino verso (${x}, ${y}, ${z}) (tolleranza ${tolerance})`);
  const goal = new GoalNear(x, y, z, tolerance);
  bot.pathfinder.setGoal(goal);
  const onReached = () => {
    console.log('[COORDS] Goal raggiunto.');
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    cleanup();
  };
  function cleanup() { bot.removeListener('goal_reached', onReached); }
  bot.once('goal_reached', onReached);
}

// ----------------- LOOK TO DIRECTION -----------------
function lookToDirection(dir) {
  if (!bot || !bot.entity) return console.log('Not connected or entity not available.');
  if (!dir) return console.log('Usage: !direction north|south|east|west (or italian: nord|sud|est|ovest)');
  dir = String(dir).trim().toLowerCase();
  const map = {
    'north': { dx: 0, dz: -1 }, 'south': { dx: 0, dz: 1 }, 'east': { dx: 1, dz: 0 }, 'west': { dx: -1, dz: 0 },
    'nord': { dx: 0, dz: -1 }, 'sud': { dx: 0, dz: 1 }, 'est': { dx: 1, dz: 0 }, 'ovest': { dx: -1, dz: 0 }
  };
  const v = map[dir];
  if (!v) return console.log('Direzione non riconosciuta. Usa north/south/east/west oppure nord/sud/est/ovest.');
  const feetPos = bot.entity.position;
  const eyeHeight = (bot.entity.height || 1.62);
  const eyePosY = feetPos.y + eyeHeight * 0.9;
  const target = vec3(feetPos.x + v.dx * 2, eyePosY, feetPos.z + v.dz * 2);
  const dx = target.x - (bot.entity.position.x);
  const dz = target.z - (bot.entity.position.z);
  const dy = target.y - (bot.entity.position.y + (bot.entity.height || 1.62) * 0.9);
  const yaw = Math.atan2(-dx, dz);
  const pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
  try {
    if (typeof bot.look === 'function') {
      bot.look(yaw, pitch, true);
      console.log(`[DIRECTION] Ora guardo verso ${dir} (yaw:${yaw.toFixed(2)} pitch:${pitch.toFixed(2)})`);
    } else {
      console.log('[DIRECTION] bot.look non disponibile su questa versione di mineflayer.');
    }
  } catch (e) {
    console.log('[DIRECTION] Errore mentre cambio direzione:', e);
  }
}

// ----------------- CLICK (left/right) general command -----------------
/**
 * clickType: 'left' or 'right'
 * targetNameOrId: optional - if present, find entity by name or id and click it; otherwise click nearest entity in front or block in front
 *
 * NOTE: this implementation uses direct packets for entity interactions to avoid rotating the bot.
 */
function performClick(clickType, targetNameOrId) {
  if (!bot) return console.log('Not connected.');
  if (!bot.entity) return console.log('Bot entity not available.');
  clickType = String(clickType || '').toLowerCase();
  if (!['left', 'right'].includes(clickType)) {
    return console.log('Usage: !click left|right [nome|id]');
  }

  let targetEntity = null;
  if (targetNameOrId) {
    targetEntity = findNPCByName(targetNameOrId);
  }

  // if no explicit target, try to find nearest entity within 6 blocks and roughly in front
  if (!targetEntity) {
    const yaw = bot.entity.yaw;
    const lookVec = { x: -Math.sin(yaw), z: Math.cos(yaw) };
    let best = null;
    for (const idStr in bot.entities) {
      const e = bot.entities[idStr];
      if (!e || e === bot.entity) continue;
      if (!e.position) continue;
      const v = { x: e.position.x - bot.entity.position.x, z: e.position.z - bot.entity.position.z };
      const dist = Math.sqrt(v.x * v.x + v.z * v.z);
      if (dist > 6) continue;
      const dot = (v.x * lookVec.x + v.z * lookVec.z) / (Math.max(dist, 0.0001));
      if (dot < 0.5) continue;
      if (!best || dist < best.dist) best = { ent: e, dist };
    }
    if (best) targetEntity = best.ent;
  }

  // helper: send packet to interact (right) with entity
  function sendUseEntityInteract(targetEntity) {
    if (!bot || !bot._client) return console.log('[CLICK] Impossibile inviare packet use_entity (client non disponibile).');
    try {
      try {
        bot._client.write('use_entity', { target: targetEntity.id, mouse: 1 });
      } catch (_) {
        bot._client.write('use_entity', { target: targetEntity.id, type: 0 });
      }
      console.log(`[CLICK] Right-click packet inviato a entità id:${targetEntity.id}`);
    } catch (e) {
      console.log('[CLICK] Fallback use_entity failed:', e);
      if (typeof bot.swingArm === 'function') bot.swingArm();
    }
  }

  // helper: send packet to attack (left) entity without rotating
  function sendUseEntityAttack(targetEntity) {
    if (!bot || !bot._client) {
      console.log('[CLICK] Impossibile inviare packet attack (client non disponibile).');
      if (typeof bot.swingArm === 'function') bot.swingArm();
      return;
    }
    try {
      try {
        bot._client.write('use_entity', { target: targetEntity.id, mouse: 0 });
      } catch (_) {
        bot._client.write('use_entity', { target: targetEntity.id, type: 1 });
      }
      console.log(`[CLICK] Attack packet inviato a entità id:${targetEntity.id}`);
    } catch (e) {
      console.log('[CLICK] Attack packet failed:', e);
      if (typeof bot.swingArm === 'function') bot.swingArm();
    }
  }

  if (clickType === 'left') {
    if (targetEntity) {
      // Use packet attack so the bot won't rotate/look at the target
      sendUseEntityAttack(targetEntity);
      return;
    }
    // fallback: left-click in air = swing arm
    if (typeof bot.swingArm === 'function') {
      bot.swingArm();
      console.log('[CLICK] Left-click fallback: swingArm eseguito.');
    } else {
      console.log('[CLICK] Left-click non possibile (API mancanti).');
    }
  } else { // right click
    if (targetEntity) {
      sendUseEntityInteract(targetEntity);
      return;
    }
    // no entity: try to right-click block in front (without turning)
    const yaw = bot.entity.yaw;
    const lookVec = { x: -Math.sin(yaw), z: Math.cos(yaw) };
    const checkPos = bot.entity.position.offset(Math.round(lookVec.x * 1.5), 0, Math.round(lookVec.z * 1.5));
    const block = bot.blockAt(checkPos);
    if (block) {
      try {
        if (typeof bot.activateBlock === 'function') {
          bot.activateBlock(block);
          console.log(`[CLICK] Right-click su blocco in ${checkPos.x},${checkPos.y},${checkPos.z}`);
          return;
        }
      } catch (e) {
        console.log('[CLICK] Errore activateBlock:', e);
      }
    }
    // fallback: swing arm
    if (typeof bot.swingArm === 'function') {
      bot.swingArm();
      console.log('[CLICK] Right-click fallback: swingArm eseguito.');
    } else {
      console.log('[CLICK] Right-click non possibile (API mancanti).');
    }
  }
}

// --- Walk forward di N blocchi (usa pathfinder) ---
function walkForward(blocks) {
  if (!bot) {
    console.log('Not connected.');
    return;
  }
  if (!bot.entity) {
    console.log('Bot entity non disponibile.');
    return;
  }
  if (!bot.pathfinder) {
    console.log('Pathfinder non inizializzato.');
    return;
  }
  blocks = Number(blocks) || 0;
  if (blocks <= 0) {
    console.log('Specifica un numero di blocchi > 0.');
    return;
  }
  const yaw = bot.entity.yaw; // radianti
  const dx = -Math.sin(yaw) * blocks;
  const dz = Math.cos(yaw) * blocks;
  const targetPos = bot.entity.position.offset(dx, 0, dz);
  const goal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1.2);
  console.log(`[WALK] Andando avanti di ${blocks} blocchi verso approx (${targetPos.x.toFixed(2)}, ${targetPos.y.toFixed(2)}, ${targetPos.z.toFixed(2)})`);
  bot.pathfinder.setGoal(goal);
  const onReached = () => {
    console.log('[WALK] Goal raggiunto.');
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    bot.removeListener('goal_reached', onReached);
    bot.removeListener('goal_updated', onGoalUpdated);
  };
  const onGoalUpdated = () => {};
  bot.once('goal_reached', onReached);
  bot.on('goal_updated', onGoalUpdated);
  setTimeout(() => {
    if (bot && bot.pathfinder && bot.pathfinder.currentGoal) {
      console.log('[WALK] Timeout: annullo il cammino.');
      try { bot.pathfinder.setGoal(null); } catch (e) {}
    }
  }, 15000);
}

// ----------------- Helper: select hotbar slot (user sees 1..9 -> code uses 0..8) -----
function selectHotbarSlotHuman(n) {
  if (!bot) return console.log('Not connected.');
  n = Number(n);
  if (!Number.isFinite(n) || n < 1 || n > 9) {
    return console.log('Usage: !hand <1-9>');
  }
  const idx = Math.max(0, Math.min(8, n - 1));
  if (typeof bot.setQuickBarSlot === 'function') {
    try {
      bot.setQuickBarSlot(idx);
      console.log(`[HAND] Hotbar slot set to ${n} (index ${idx})`);
    } catch (e) {
      console.log('[HAND] Errore nel settare lo slot hotbar:', e);
    }
  } else if ('quickBarSlot' in bot) {
    // fallback: set property if available
    try {
      bot.quickBarSlot = idx;
      console.log(`[HAND] Hotbar slot (fallback) set to ${n} (index ${idx})`);
    } catch (e) {
      console.log('[HAND] Fallback failure when setting quick bar slot:', e);
    }
  } else {
    console.log('[HAND] La versione di mineflayer in uso non supporta setQuickBarSlot.');
  }
}

// ----------------- Helper: right click current held item (activate/deactivate quickly) -----
function rightClickHeldItem() {
  if (!bot) return console.log('Not connected.');
  if (!bot.entity) return console.log('Bot entity not available.');
  // if there's no item in hand, still try to activate (harmless)
  try {
    if (typeof bot.activateItem === 'function') {
      bot.activateItem();
      console.log('[COMPASS] Activated held item (simulating right click).');
      // deactivate shortly after to emulate a single right click
      setTimeout(() => {
        try { if (typeof bot.deactivateItem === 'function') bot.deactivateItem(); } catch (e) {}
      }, 150);
    } else {
      // fallback: try to send a placement/use packet (best-effort)
      if (bot._client && bot._client.write) {
        try {
          // use_item packet (protocol dependent) - best-effort and may be ignored on some protocols
          try { bot._client.write('use_item'); } catch (_) { /* ignore */ }
          console.log('[COMPASS] Sent use_item packet (fallback).');
        } catch (e) {
          console.log('[COMPASS] Fallback use_item failed:', e);
        }
      } else {
        console.log('[COMPASS] bot.activateItem not available and client write not available.');
      }
    }
  } catch (e) {
    console.log('[COMPASS] Errore durante il right-click dell\'item in mano:', e);
  }
}

// ----------------- Helper: show GUI slots and prompt for a pick, then click it -----
function showGuiAndPrompt() {
  if (!bot) return console.log('Not connected.');
  if (!bot.currentWindow) {
    console.log('[GUI] Nessuna GUI aperta.');
    rl.prompt();
    return;
  }
  const win = bot.currentWindow;
  console.log(`[GUI] Finestra aperta: id=${win.id} title="${win.title}" size=${win.slots.length}`);
  // Print each slot with index and item info
  for (let i = 0; i < win.slots.length; i++) {
    const it = win.slots[i];
    if (it) {
      // try to get item name
      let iname = it.name || (it.displayName ? it.displayName : null);
      if (!iname) {
        try {
          const md = mcDataLib(bot.version);
          const def = md.items[it.type];
          if (def && def.name) iname = def.name;
        } catch (e) { /* ignore */ }
      }
      iname = iname || (`#${it.type}`);
      console.log(` - ${i}: ${iname} x${it.count}`);
    } else {
      console.log(` - ${i}: <empty>`);
    }
  }

  // ask user for a slot number or name
  rl.question('Enter item slot number or item name to click: ', (answer) => {
    const a = String(answer || '').trim();
    if (!a) {
      console.log('[GUI] Input vuoto, annullo.');
      rl.prompt();
      return;
    }
    let chosenSlot = null;

    if (/^\d+$/.test(a)) {
      const idx = Number(a);
      if (idx >= 0 && idx < win.slots.length) {
        chosenSlot = idx;
      } else {
        console.log('[GUI] Slot number out of range.');
        rl.prompt();
        return;
      }
    } else {
      // search by name (first match)
      const q = normalizeText(a);
      let found = null;
      for (let i = 0; i < win.slots.length; i++) {
        const it = win.slots[i];
        if (!it) continue;
        let iname = it.name || (it.displayName ? it.displayName.toString() : '');
        if (!iname) {
          try {
            const md = mcDataLib(bot.version);
            const def = md.items[it.type];
            if (def && def.name) iname = def.name;
          } catch (e) { /* ignore */ }
        }
        if (!iname) continue;
        if (normalizeText(iname).includes(q)) {
          found = i;
          break;
        }
      }
      if (found === null) {
        console.log('[GUI] Nessun item trovato con quel nome.');
        rl.prompt();
        return;
      }
      chosenSlot = found;
    }

    // perform click on chosenSlot: mouseButton 0 (left click) mode 0 (normal)
    try {
      if (typeof bot.clickWindow === 'function') {
        bot.clickWindow(chosenSlot, 0, 0, (err) => {
          if (err) console.log('[GUI] Click fallito:', err);
          else console.log(`[GUI] Click effettuato sullo slot ${chosenSlot}.`);
          rl.prompt();
        });
      } else if (bot._client && bot._client.write) {
        // fallback: attempt a window_click packet (best-effort); fields vary by protocol - best-effort only
        try {
          bot._client.write('window_click', { windowId: win.id, slot: chosenSlot, mouseButton: 0, mode: 0 });
          console.log(`[GUI] Click (fallback) inviato sullo slot ${chosenSlot}.`);
        } catch (e) {
          console.log('[GUI] Fallback click failed:', e);
        }
        rl.prompt();
      } else {
        console.log('[GUI] clickWindow non disponibile su questa versione di mineflayer.');
        rl.prompt();
      }
    } catch (e) {
      console.log('[GUI] Errore durante il click:', e);
      rl.prompt();
    }
  });
}

// ----------------- New helpers for looping & async flows -----------------
function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function waitForWindow(botInstance, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (!botInstance) return reject(new Error('No bot'));
    if (botInstance.currentWindow) return resolve(botInstance.currentWindow);
    let elapsed = 0;
    const interval = 200;
    const check = setInterval(() => {
      elapsed += interval;
      if (botInstance.currentWindow) {
        clearInterval(check);
        return resolve(botInstance.currentWindow);
      }
      if (elapsed >= timeout) {
        clearInterval(check);
        return reject(new Error('window open timeout'));
      }
    }, interval);
  });
}

function clickWindowAsync(botInstance, slot, mouse = 0, mode = 0, timeout = 3000) {
  return new Promise((resolve) => {
    if (!botInstance) {
      console.log('[clickWindowAsync] no botInstance, resolving.');
      return resolve();
    }

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      resolve();
    }

    try {
      console.log(`[clickWindowAsync] sending click slot=${slot} mouse=${mouse} mode=${mode}`);

      if (typeof botInstance.clickWindow === 'function') {
        // Use the callback if available
        try {
          botInstance.clickWindow(slot, mouse, mode, (err) => {
            console.log('[clickWindowAsync] clickWindow callback fired, err=', err);
            // small settle delay for server processing
            setTimeout(() => finish(), 150);
          });
        } catch (e) {
          console.log('[clickWindowAsync] exception calling clickWindow:', e);
          // fall through to timeout-based finish
        }
      } else if (botInstance._client && botInstance.currentWindow) {
        // fallback to sending a raw packet (best-effort)
        try {
          botInstance._client.write('window_click', { windowId: botInstance.currentWindow.id, slot, mouseButton: mouse, mode });
          console.log('[clickWindowAsync] fallback: wrote window_click packet');
        } catch (e) {
          console.log('[clickWindowAsync] fallback write error:', e);
        }
        // resolve after a short delay
        setTimeout(() => finish(), 200);
      } else {
        console.log('[clickWindowAsync] no clickWindow and no client.write available, resolving after short delay.');
        setTimeout(() => finish(), 200);
      }
    } catch (e) {
      console.log('[clickWindowAsync] unexpected exception:', e);
      setTimeout(() => finish(), 200);
    }

    // Safety: global timeout so the promise never hangs forever
    setTimeout(() => {
      if (!finished) {
        console.log('[clickWindowAsync] global timeout reached, resolving anyway.');
        finish();
      }
    }, timeout);
  });
}


function closeWindowSafe(botInstance) {
  try {
    if (!botInstance) return;
    if (typeof botInstance.closeWindow === 'function') {
      try { botInstance.closeWindow(botInstance.currentWindow); } catch (_) { try { botInstance.closeWindow(); } catch (_) {} }
    } else if (botInstance._client && botInstance.currentWindow) {
      try { botInstance._client.write('close_window', { windowId: botInstance.currentWindow.id }); } catch (_) {}
    }
  } catch (e) { /* ignore */ }
}

// ----------------- Robust shift-click implementation -----------------
/**
 * Shift-click all player inventory items into the currently open container window.
 * This version attempts:
 *  - If the window contains player inventory slots (window.slots.length >= 36), map player region correctly.
 *  - Iterate player slots and shift-click them (window click with mode=1).
 *  - If that fails, fall back to trying to click container slots matching item types.
 */
async function shiftAllPlayerItemsIntoOpenWindow(botInstance, perClickDelay = 120) {
  if (!botInstance) return;
  const win = botInstance.currentWindow;
  if (!win) {
    console.log('[SHIFT] No window open to shift items into.');
    return;
  }
  const total = win.slots.length;
  // Common layout: container slots (0..N-37), then player inventory slots (N-36..N-1) where N = total slots.
  const hasPlayerRegion = total >= 36;
  let playerStart = hasPlayerRegion ? (total - 36) : null;
  if (hasPlayerRegion) {
    console.log(`[SHIFT] Window size ${total}, assuming player region starts at ${playerStart}`);
    // Iterate player inventory slots  (0..35) mapped to window indices
    // Map bot.inventory.slots index ordering to player region indices:
    // bot.inventory.slots is typically length 36 (or >=), but we read up to 36 (main inventory)
    const invSlots = botInstance.inventory.slots || [];
    // We'll attempt mapping for the typical 36 main slots:
    for (let invIndex = 0; invIndex < 36; invIndex++) {
      const item = invSlots[invIndex];
      if (!item) continue;
      const windowIndex = playerStart + invIndex;
      if (windowIndex < 0 || windowIndex >= total) {
        console.log(`[SHIFT] windowIndex out of range for invIndex ${invIndex} -> ${windowIndex}`);
        continue;
      }
      try {
        await clickWindowAsync(botInstance, windowIndex, 0, 1); // mode=1 shift-click
        await wait(perClickDelay);
      } catch (e) {
        console.log('[SHIFT] click error for', windowIndex, e);
      }
    }
    // done
    return;
  }

  // Fallback if window doesn't include player region: try to move based on matching slots
  try {
    console.log('[SHIFT] Window does not contain a player region, attempting fallback mapping by matching types.');
    const invSlots = botInstance.inventory.slots || [];
    for (let invIndex = 0; invIndex < invSlots.length; invIndex++) {
      const item = invSlots[invIndex];
      if (!item) continue;
      // find a slot in container region that is empty or matches type and try to click that slot (mode=1)
      let found = null;
      // Prefer empty container slots
      for (let i = 0; i < win.slots.length; i++) {
        if (!win.slots[i]) { found = i; break; }
      }
      // else try to find first container slot with same type to merge
      if (found === null) {
        for (let i = 0; i < win.slots.length; i++) {
          const w = win.slots[i];
          if (w && w.type === item.type) { found = i; break; }
        }
      }
      if (found !== null) {
        try {
          await clickWindowAsync(botInstance, found, 0, 1);
          await wait(perClickDelay);
        } catch (e) {
          console.log('[SHIFT] click error for', found, e);
        }
      } else {
        // last resort: try tossStack for that item
        try {
          if (typeof botInstance.tossStack === 'function') {
            await new Promise((res) => botInstance.tossStack(item, res));
            await wait(perClickDelay);
          }
        } catch (e) {
          console.log('[SHIFT] fallback toss error for invIndex', invIndex, e);
        }
      }
    }
  } catch (e) {
    console.log('[SHIFT] Error during fallback shift:', e);
  }
}

// drop all remaining items from the bot inventory
async function dropAllInventory(botInstance) {
  if (!botInstance?.inventory?.slots) return;

  try {
    for (let i = 0; i < botInstance.inventory.slots.length; i++) {
      const it = botInstance.inventory.slots[i];
      if (!it) continue;

      try {
        if (typeof botInstance.tossStack === 'function') {
          await botInstance.tossStack(it);  // ✅ preferred way
        } else if (typeof botInstance.toss === 'function') {
          await botInstance.toss(it.type, null, it.count);  // ✅ fallback
        } else {
          // Fallback to clickWindow (less reliable)
          if (botInstance.currentWindow) {
            const win = botInstance.currentWindow;
            const candidate = win.slots.length - 36 + i;

            if (candidate >= 0 && candidate < win.slots.length) {
              await clickWindowAsync(botInstance, candidate, 1, 4); // right-click-drop
            }
          }
        }
      } catch (e) {
        console.log('[DROP] Error tossing slot', i, e);
      }

      await wait(80); // slight delay between drops
    }
  } catch (e) {
    console.log('[DROP] Error during dropAllInventory:', e);
  }
}


// perform a single iteration of the loop for a given bot instance
async function performLoopOnce(botInstance) {
  if (!botInstance) return;
  try {
    const prefix = botInstance === bot ? '[LOOP]' : `[AUX:${botInstance.username}] [LOOP]`;
    console.log(`${prefix} Step 1: /kits`);
    try { botInstance.chat('/kits'); } catch (e) { console.log(`${prefix} chat failed:`, e); }
    // wait for GUI and click slot 11 (index 11)
    try {
      const win = await waitForWindow(botInstance, 10000).catch(() => null);
      if (win) {
        console.log(`${prefix} GUI opened after /kits, clicking slot 11...`);
        await clickWindowAsync(botInstance, 11, 0, 0);
        await wait(400);
        closeWindowSafe(botInstance);
        await wait(300);
      } else {
        console.log(`${prefix} No GUI opened for /kits or timeout.`);
      }
    } catch (e) {
      console.log(`${prefix} Error handling kits GUI:`, e);
    }

    await wait(500);

    // /sell and put all items in GUI
    console.log(`${prefix} Step 2: /sell`);
    try { botInstance.chat('/sell'); } catch (e) { console.log(`${prefix} chat failed:`, e); }
    // wait for sell GUI
    try {
      const sellWin = await waitForWindow(botInstance, 10000).catch(() => null);
      if (sellWin) {
        console.log(`${prefix} Sell GUI opened, shifting player items into it...`);
        // robust shift: uses mapping from window slots
        await shiftAllPlayerItemsIntoOpenWindow(botInstance, 200);
        await wait(300);
        closeWindowSafe(botInstance);
        await wait(300);
      } else {
        console.log(`${prefix} No sell GUI opened or timeout.`);
      }
    } catch (e) {
      console.log(`${prefix} Error handling sell GUI:`, e);
    }

    await wait(500);

    // drop remaining items
    console.log(`${prefix} Step 3: drop remaining inventory items`);
    await dropAllInventory(botInstance);

    await wait(400);

    // pay (only for main bot per your original code)
    if (botInstance === bot) {
      console.log(`${prefix} Step 4: /pay strawberrry_02 20000`);
      try { botInstance.chat('/pay afrut 12000'); } catch (e) { console.log(`${prefix} chat failed:`, e); }
    } else {
      // aux bots: you may want different pay behavior; keep none for now or customize
      console.log(`${prefix} Aux bot: skipping /pay step.`);
    }

  } catch (e) {
    console.log('[LOOP] performLoopOnce exception:', e);
  }
}

// ----------------- Loop controller for the main bot -----------------
let mainLoopRunning = false;
let mainLoopHandle = null;

async function mainLoopStart() {
  if (!bot) {
    console.log('[!loop] No main bot connected.');
    return;
  }
  if (mainLoopRunning) {
    console.log('[!loop] Already running.');
    return;
  }
  mainLoopRunning = true;
  console.log('[!loop] Starting main loop (will repeat every 5min5s). Use !loop to stop.');
  while (mainLoopRunning) {
    if (!bot) {
      console.log('[!loop] Bot disconnected, stopping loop.');
      break;
    }
    await performLoopOnce(bot);
    if (!mainLoopRunning) break;
    // wait 5min5s
    const waitMs = 5 * 60 * 1000 + 5 * 1000;
    console.log(`[!loop] Waiting ${Math.round(waitMs/1000)}s before next iteration...`);
    // sleep in small increments to allow stop signal
    const step = 2000;
    let slept = 0;
    while (slept < waitMs && mainLoopRunning) {
      await wait(Math.min(step, waitMs - slept));
      slept += step;
    }
  }
  mainLoopRunning = false;
  console.log('[!loop] Loop stopped.');
}

function mainLoopStop() {
  mainLoopRunning = false;
}

// ----------------- Create auxiliary bots for /accounts -----------------
function randomLetters(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// new helper: put inventory into open window by clicking player-inventory slots one-by-one with a given delay (ms)
async function putInventoryIntoOpenWindowWithDelay(botInstance, delayMs = 500) {
  if (!botInstance) return;
  const win = botInstance.currentWindow;
  if (!win) {
    console.log('[PUT] No window open to put inventory into.');
    return;
  }
  const total = win.slots.length;
  const has36 = total >= 36;
  const containerSize = has36 ? total - 36 : 0;
  // iterate player's inventory slots in typical order: 0..(inventorySlots-1)
  const invSlots = botInstance.inventory.slots.length || 36;
  for (let invIndex = 0; invIndex < invSlots; invIndex++) {
    const item = botInstance.inventory.slots[invIndex];
    if (!item) continue;
    // map to window index: containerSize + invIndex is the usual mapping
    let windowIndex = containerSize + invIndex;
    if (!has36 || windowIndex < 0 || windowIndex >= total) {
      // fallback: try to find a slot in window that matches item type and is in player region
      let found = null;
      for (let i = 0; i < total; i++) {
        const wItem = win.slots[i];
        if (!wItem) continue;
        if (wItem.type === item.type) { found = i; break; }
      }
      if (found !== null) windowIndex = found;
      else windowIndex = Math.max(0, Math.min(total - 1, invIndex)); // last fallback: use invIndex
    }
    try {
      await clickWindowAsync(botInstance, windowIndex, 0, 1); // mode=1 shift-click
    } catch (e) {
      console.log('[PUT] click error for window slot', windowIndex, e);
    }
    await wait(delayMs);
  }
}

/*
  NEW createAuxBotAndRunFlow: rewritten to implement EXACT flow you requested.
  Sequence on spawn:
   - wait 5s
   - /register <random8>
   - wait 10s
   - select hotbar slot 5
   - wait 2s
   - right click held item
   - wait 2s
   - click slot 42 (if GUI)
   - wait 10s
   - /warp War
   - wait 10s
   - Then start perpetual loop:
       /kit -> wait 2s -> click slot 10 -> wait1s -> close gui -> wait1s
       /sell -> wait for GUI -> put each inventory item (0.5s each) -> close gui
       drop all inventory
       /pay strawberry_02 20000
     After /pay schedule next kit-run at now + 5min5s (per-bot timer, non-blocking)
*/
function createAuxBotAndRunFlow(host, port = 25565, version = '1.21.1') {
  return new Promise((resolve) => {
    const username = randomLetters(8); // random username
    const aux = mineflayer.createBot({ host, port, username, version });
    // LOAD pathfinder for aux bots so they can walk
    try { aux.loadPlugin(pathfinder); } catch (e) { console.log(`[ACCT:${username}] Failed to load pathfinder plugin:`, e); }

    console.log(`[ACCT] Creating aux bot ${username} -> ${host}:${port} (ver ${version})`);
     wait(2000)
    // Always log chat/messages for aux bot
    aux.on('chat', (from, message) => {
      if (!from) return;
      if (from === aux.username) return;
      console.log(`[ACCT:${username}] <${from}> ${message}`);
    });
    aux.on('message', (jsonMsg) => {
      try {
        const text = jsonMsg.toString();
        console.log(`[ACCT:${username}] [MSG] ${text}`);
      } catch (e) {
        console.log(`[ACCT:${username}] [MSG] (unparsable)`, jsonMsg);
      }
    });
    aux.on('kicked', (reason) => console.log(`[ACCT:${username}] kicked:`, reason && reason.toString ? reason.toString() : reason));
    aux.on('error', (err) => console.log(`[ACCT:${username}] error:`, err && err.message ? err.message : err));
    aux.on('end', () => console.log(`[ACCT:${username}] disconnected`));

    // Helper: safely set hotbar slot on aux
    function setHotbar(auxBot, humanSlot) {
      const idx = Math.max(0, Math.min(8, (Number(humanSlot) - 1)));
      try {
        if (typeof auxBot.setQuickBarSlot === 'function') auxBot.setQuickBarSlot(idx);
        else if ('quickBarSlot' in auxBot) auxBot.quickBarSlot = idx;
        console.log(`[ACCT:${username}] set hotbar to ${humanSlot} (idx ${idx})`);
      } catch (e) {
        console.log(`[ACCT:${username}] setHotbar error:`, e);
      }
    }

    // helper: right-click held item on aux
    function activateHeld(auxBot) {
      wait(100)
      try {
        if (typeof auxBot.activateItem === 'function') {
          auxBot.activateItem();
          setTimeout(() => {
            try { if (typeof auxBot.deactivateItem === 'function') auxBot.deactivateItem(); } catch (e) {}
          }, 150);
          console.log(`[ACCT:${username}] activateItem called`);
        } else if (auxBot._client && auxBot._client.write) {
          try { auxBot._client.write('use_item'); } catch (_) {}
          console.log(`[ACCT:${username}] fallback use_item packet sent`);
        }
      } catch (e) {
        console.log(`[ACCT:${username}] activateHeld error:`, e);
      }
    }
    

    
    


    async function cycleAndScheduleNext() {
      // Run exactly the kit->sell->drop->pay cycle
      console.log("siuiiiii")
      await wait(200000);

      await runKitSellPayCycle();

      
      
    }
    // The part starting from /kit -> click slot 10 -> /sell -> put items -> drop -> /pay
    async function runKitSellPayCycle() {
      try {
        if (!aux || aux._client === undefined) {
          console.log(`[ACCT:${username}] Bot not ready for kit-sell cycle.`);
          return;
        }
    
        try {
          console.log(`[ACCT:${username}] Cycle START: /kit -> click slot 10 -> /sell -> put items -> drop -> /pay`);
    
          // /kit
          try { aux.chat('/kit'); console.log(`[ACCT:${username}] Sent /kit`); } catch (e) { console.log(`[ACCT:${username}] chat /kit failed:`, e); }
          await wait(2000);
    
          // wait for GUI and click slot 10
          try {
            const win = await waitForWindow(aux, 7000).catch(() => null);
            if (win) {
              console.log(`[ACCT:${username}] Kit GUI opened, clicking slot 10`);
              await clickWindowAsync(aux, 10, 0, 0);
              await wait(1000);
              closeWindowSafe(aux);
            } else {
              console.log(`[ACCT:${username}] Kit GUI did not open or timed out.`);
            }
          } catch (e) {
            console.log(`[ACCT:${username}] Error handling kit GUI:`, e);
          }
    
          await wait(1000);
    
          // /sell -> put each individual item/stack with 0.5s gap
          try { aux.chat('/sell'); console.log(`[ACCT:${username}] Sent /sell`); } catch (e) { console.log(`[ACCT:${username}] chat /sell failed:`, e); }
          const sellWin = await waitForWindow(aux, 7000).catch(() => null);
          if (sellWin) {
            console.log(`[ACCT:${username}] Sell GUI opened, putting inventory items into it (0.5s delay each)`);
            const total = sellWin.slots.length;
            const has36 = total >= 36;
            const playerStart = has36 ? (total - 36) : null;
    
            for (let invIndex = 0; invIndex < (aux.inventory.slots.length || 36); invIndex++) {
              const item = aux.inventory.slots[invIndex];
              if (!item) continue;
    
              let windowIndex = (playerStart !== null) ? (playerStart + invIndex) : null;
              if (windowIndex === null || windowIndex < 0 || windowIndex >= total) {
                let found = null;
                for (let i = 0; i < total; i++) {
                  if (!sellWin.slots[i]) { found = i; break; }
                }
                if (found === null) {
                  for (let i = 0; i < total; i++) {
                    const w = sellWin.slots[i];
                    if (w && w.type === item.type) { found = i; break; }
                  }
                }
                windowIndex = (found !== null) ? found : Math.max(0, Math.min(total - 1, invIndex));
              }
    
              try {
                await clickWindowAsync(aux, windowIndex, 0, 1);
                console.log(`[ACCT:${username}] moved inventory slot ${invIndex} -> window ${windowIndex}`);
              } catch (e) {
                console.log(`[ACCT:${username}] error moving inventory slot ${invIndex} -> ${windowIndex}`, e);
              }
    
              await wait(50);
            }
    
            await wait(300);
            closeWindowSafe(aux);
            await wait(300);
            try { aux.chat('/pay afrut 12000'); console.log(`[ACCT:${username}] Sent /pay strawberry_02 20000`); } catch (e) { console.log(`[ACCT:${username}] chat /pay failed:`, e); }
          } else {
            console.log(`[ACCT:${username}] Sell GUI did not open or timed out.`);
          }
    
        } catch (innerErr) {
          // Catch any unexpected errors above, but allow finalpart to still run
          console.log(`[ACCT:${username}] Error during kit-sell-pay steps:`, innerErr);
        }
    
        // ✅ Always runs no matter what
        console.log("finalpart");
        
        
    
        // Drop all inventory
        console.log(`[ACCT:${username}] Dropping all inventory`);
        try { await dropAllInventory(aux); } catch (e) { console.log(`[ACCT:${username}] dropAllInventory error:`, e); }
        try { await listInventory(bot); } catch (e) { console.log(`[ACCT:${username}] istinv error:`, e); }
        try { await cycleAndScheduleNext(); } catch (e) { console.log(`[ACCT:${username}] cycleAndScheduleNext error:`, e); }
    
        try { aux.chat('/pay afrut 12000'); console.log(`[ACCT:${username}] Sent /pay strawberry_02 20000`); } catch (e) { console.log(`[ACCT:${username}] final /pay failed:`, e); }
    
        await wait(500);
      } catch (cycleErr) {
        console.log(`[ACCT:${username}] Unexpected outer error in runKitSellPayCycle:`, cycleErr);
      }
    }
    
    function listInventory(bot) {
      bot.on('chat', (username, message) => {
        if (username === bot.username) return;
    
        if (message === '!inv') {
          const items = bot.inventory.items();
    
          if (items.length === 0) {
            bot.chat("My inventory is empty.");
            return;
          }
    
          const MAX_CHAT_LENGTH = 256;
          let msg = "I have: ";
    
          for (const item of items) {
            const part = `${item.count}x ${item.name}, `;
            if ((msg + part).length > MAX_CHAT_LENGTH) break;
            msg += part;
          }
    
          msg = msg.slice(0, -2); // Remove trailing comma and space
          bot.chat(msg);
        }
      });
    }

    // Start initial sequence on spawn and then schedule kit cycles forever (per-bot timer)
    aux.once('spawn', async () => {
      try {
        console.log(`[ACCT:${username}] Spawned. Beginning initial sequence...`);

        // wait 5s after spawn
        await wait(10000)

        // /register random 8 chars
        const password = randomLetters(8);
        try { aux.chat(`/register ${password}`); console.log(`[ACCT:${username}] Sent /register ${password}`); } catch (e) { console.log(`[ACCT:${username}] chat /register failed:`, e); }

        // wait 10s after register
        
        await wait(randomInt(100000));
        // select slot 5 (hotbar 5)
        setHotbar(aux, 5);
        await wait(2000);

        // right click the hand
        activateHeld(aux);
        console.log("cidfsao")
        // click slot 42 (if GUI opens)
        try {
          const win = await waitForWindow(aux, 6000).catch(() => null);
          if (win) {
            console.log(`[ACCT:${username}] GUI opened after right click; clicking slot 42`);
            await clickWindowAsync(aux, 42, 0, 0);
            console.log("heloo")
            await wait(2000); // wait 10s per your steps
            closeWindowSafe(aux);
          } else {
            console.log(`[ACCT:${username}] No GUI opened after right click (or timeout). Waiting 10s then continue.`);
            await wait(randomInt(15000));
          }
        } catch (e) {
          console.log(`[ACCT:${username}] Error clicking slot 42:`, e);
        }
        console.log("ciao")
        // /warp War
        try { aux.chat('/warp War'); console.log(`[ACCT:${username}] Sent /warp War`); } catch (e) { console.log(`[ACCT:${username}] chat /warp failed:`, e); }

        // WAIT 5s then perform a random walk of 3..8 blocks in a random direction
        try {
          await wait(5000);

          // ensure Movements are set for aux.pathfinder
          try {
            const mcData = mcDataLib(aux.version);
            const defaultMove = new Movements(aux, mcData);
            aux.pathfinder.setMovements(defaultMove);
            console.log(`[ACCT:${username}] Pathfinder movements set for aux.`);
          } catch (e) {
            console.log(`[ACCT:${username}] Could not set movements for pathfinder:`, e && e.message ? e.message : e);
          }

          // choose random blocks between 3 and 8 (randomInt(3,9) => 3..8)
          const blocks = randomInt(3, 9);
          // random direction yaw in radians
          const yaw = Math.random() * Math.PI * 2;
          const dx = -Math.sin(yaw) * blocks;
          const dz = Math.cos(yaw) * blocks;

          if (!aux.entity || !aux.entity.position) {
            console.log(`[ACCT:${username}] Cannot perform walk: no entity position available.`);
          } else {
            const targetPos = aux.entity.position.offset(dx, 0, dz);
            console.log(`[ACCT:${username}] Walking randomly ${blocks} blocks towards approx (${targetPos.x.toFixed(2)}, ${targetPos.y.toFixed(2)}, ${targetPos.z.toFixed(2)})`);
            const walkGoal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1.2);
            try {
              aux.pathfinder.setGoal(walkGoal);

              // await goal reached or timeout (15s)
              await new Promise((resolve) => {
                let finished = false;
                const onReached = () => {
                  if (finished) return;
                  finished = true;
                  console.log(`[ACCT:${username}] Random walk reached goal.`);
                  try { aux.pathfinder.setGoal(null); } catch (_) {}
                  aux.removeListener('goal_reached', onReached);
                  resolve();
                };
                aux.once('goal_reached', onReached);

                setTimeout(() => {
                  if (finished) return;
                  finished = true;
                  console.log(`[ACCT:${username}] Random walk timeout — cancelling goal.`);
                  try { aux.pathfinder.setGoal(null); } catch (_) {}
                  aux.removeListener('goal_reached', onReached);
                  resolve();
                }, 15000);
              });
            } catch (e) {
              console.log(`[ACCT:${username}] Error while performing random walk:`, e);
            }
          }
        } catch (walkErr) {
          console.log(`[ACCT:${username}] Unexpected error during walk step:`, walkErr);
        }

        // Now start the repeating cycle but we will schedule the first cycle immediately
        // The repeating cycle should run this sequence and then schedule the next cycle at t+5min5s
        runKitSellPayCycle();

        // Start the first cycle immediately (as soon as initial steps are done)
       

        resolve(aux);
      } catch (spawnErr) {
        console.log(`[ACCT:${username}] Unexpected spawn handler error:`, spawnErr);
        resolve(aux);
      }
    });

  });
}

// Console: parse commands and send to chat
rl.on('line', (line) => {
  const trimmed = line.trim();

  // If we're waiting for an IGN to complete a pending /connect, treat the next non-empty line as the username
  if (pendingConnect) {
    if (!trimmed) {
      // ignore blank lines and keep waiting
      rl.prompt();
      return;
    }
    const username = trimmed;
    const { host, port, version } = pendingConnect;
    pendingConnect = null;
    if (bot) {
      console.log('Disconnecting current bot before connecting...');
      bot.end('Switching connection from console command');
      setTimeout(() => createBot({ host, port, username, version }), 350);
    } else {
      createBot({ host, port, username, version });
    }
    rl.prompt();
    return;
  }

  if (!trimmed) { rl.prompt(); return; }

  // comandi custom '!'
  if (trimmed.startsWith('!')) {
    const parts = trimmed.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    if (cmd === 'lista') {
      scanAndLogNPCs();
    } else if (cmd === 'walk' || cmd === 'wal') {
      const blocks = args[0] ? Number(args[0]) : 0;
      walkForward(blocks);
    } else if (cmd === 'coords') {
      // !coords x y z
      if (args.length < 3) { console.log('Usage: !coords x y z'); }
      else { walkToCoords(args[0], args[1], args[2]); }
    } else if (cmd === 'direction' || cmd === 'dir') {
      if (args.length < 1) { console.log('Usage: !direction north|south|east|west (o italiane: nord/sud/est/ovest)'); }
      else { lookToDirection(args[0]); }
    } else if (cmd === 'npc') {
      const name = args.join(' ').trim();
      if (!name) { console.log('Usage: !npc [nome|id]'); }
      else { goToNPCAndClick(name, 'left'); }
    } else if (cmd === 'npcid') {
      const id = args[0];
      if (!id) { console.log('Usage: !npcid [entityId]'); }
      else {
        const ent = bot ? bot.entities[Number(id)] : null;
        if (!ent) console.log('Entità non trovata per id', id);
        else goToNPCAndClick(ent, 'left');
      }
    } else if (cmd === 'click') {
      // !click left|right [nome|id]
      const clickType = args[0] ? args[0].toLowerCase() : null;
      const target = args.slice(1).join(' ').trim() || null;
      if (!clickType || !['left', 'right'].includes(clickType)) {
        console.log('Usage: !click left|right [nome|id]');
      } else {
        performClick(clickType, target);
      }
    } else if (cmd === 'debug') {
      console.log('DEBUG: bot.entities (conciso) ->');
      const list = scanAndLogNPCs(false);
      console.dir(list, { depth: 2, maxArrayLength: 200 });
    } else if (cmd === 'hand') {
      // new: select hotbar slot (human 1..9)
      const n = args[0];
      if (!n) console.log('Usage: !hand <1-9>');
      else selectHotbarSlotHuman(n);
    } else if (cmd === 'compass') {
      // new: right click held item (simulate using held item)
      rightClickHeldItem();
    } else if (cmd === 'gui') {
      // new: list GUI contents and prompt for a selection
      showGuiAndPrompt();
    } else if (cmd === 'loop') {
      // toggle main loop
      if (!bot) { console.log('[!loop] No bot connected.'); }
      else {
        if (!mainLoopRunning) {
          mainLoopStart().catch((e) => console.log('[!loop] start error:', e));
        } else {
          console.log('[!loop] Stopping loop...');
          mainLoopStop();
        }
      }
    } else {
      console.log('Comando ! non riconosciuto.');
    }
    rl.prompt();
    return;
  }

  // comandi '/' già presenti
  if (trimmed.startsWith('/connect ')) {
    const parts = trimmed.split(/\s+/).slice(1);
    const host = parts[0];
    if (!host) {
      console.log('Usage: /connect host [port] [version] [username]');
      rl.prompt();
      return;
    }
    const port = parts[1] ? parseInt(parts[1], 10) : 25565;
    const version = parts[2] || '1.21.1';
    const usernameArg = parts[3] || null;

    if (usernameArg) {
      // if username provided inline, just use it
      const username = usernameArg;
      if (bot) {
        console.log('Disconnecting current bot before connecting...');
        bot.end('Switching connection from console command');
        setTimeout(() => createBot({ host, port, username, version }), 350);
      } else {
        createBot({ host, port, username, version });
      }
    } else {
      // ask for IGN: the next non-empty console line will be used as username
      pendingConnect = { host, port, version };
      console.log('Enter IGN to use: (type the IGN and press Enter)');
    }
    rl.prompt();
    return;
  } else if (trimmed.startsWith('/accounts')) {
    // /accounts [n]
    const parts = trimmed.split(/\s+/);
    const n = parts[1] ? Math.max(1, parseInt(parts[1], 10) || 5) : 5;
    console.log(`[ACCOUNTS] Creating ${n} auxiliary bots on metamc.it (may take a while).`);
    for (let i = 0; i < n; i++) {
      // small stagger between creations to avoid hammering
      setTimeout(() => {
        createAuxBotAndRunFlow('metamc.it', 25565, '1.21.1').then((aux) => {
          console.log('[ACCOUNTS] Aux bot created and started its flow:', aux ? aux.username : '(unknown)');
        }).catch((e) => console.log('[ACCOUNTS] Aux creation error:', e));
      }, i * 1500);
    }
    rl.prompt();
    return;
  } else if (trimmed === '/disconnect') {
    if (bot) { bot.end('Disconnected by console'); } else { console.log('Not connected.'); }
  } else if (trimmed === '/quit' || trimmed === '/exit') {
    if (bot) { bot.end('Exiting'); }
    console.log('Bye.');
    process.exit(0);
  } else {
    // Send chat message
    if (bot) {
      try { bot.chat(trimmed); } catch (e) { console.error('Failed to send chat:', e); }
    } else {
      console.log('Not connected. Use /connect host [port] to connect, or /quit to exit.');
    }
  }
  rl.prompt();
});

rl.on('close', () => {
  if (bot) bot.end('Console closed');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received.');
  if (bot) bot.end('SIGINT');
  process.exit(0);
});

console.log('Console-bot ready. Commands: /connect host [port] [version] [username], /disconnect, /quit');
console.log('Comandi custom: !lista, !walk [blocchi], !coords x y z, !direction north|south|east|west (o italiane), !click left|right [nome|id], !npc [nome|id], !npcid [id], !debug, !hand, !compass, !gui, !loop (toggle), /accounts');
rl.prompt();

// ------------------ AUTO-START ACCOUNTS ON LAUNCH ------------------
// The user requested that instead of waiting for /accounts at start, the script
// should automatically start 5 accounts separated by 1 minute each.
// You can change these constants as needed.
const AUTO_START_ACCOUNTS = true;
const AUTO_START_COUNT = 5;
const AUTO_START_INTERVAL_MS = 60 * 1000; // 1 minute

if (AUTO_START_ACCOUNTS) {
  console.log(`[AUTO] Auto-starting ${AUTO_START_COUNT} aux accounts on metamc.it, ${AUTO_START_INTERVAL_MS/1000}s apart.`);
  for (let i = 0; i < AUTO_START_COUNT; i++) {
    const delay = i * AUTO_START_INTERVAL_MS;
    setTimeout(() => {
      createAuxBotAndRunFlow('metamc.it', 25565, '1.21.1')
        .then((aux) => {
          console.log(`[AUTO] Aux bot started: ${aux ? aux.username : '(unknown)'} (scheduled +${Math.round(delay/1000)}s)`);
        })
        .catch((err) => {
          console.log('[AUTO] Aux creation error:', err);
        });
    }, delay);
  }
}
