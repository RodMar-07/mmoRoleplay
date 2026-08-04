const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: 
  { origin: "*", methods: ["GET", "POST"] }
});

const ROLE_STATS = {
  Medico: { maxWeight: 30, initialVitals: { hp: 100, hunger: 100, thirst: 100 } },
  Recolector: { maxWeight: 60, initialVitals: { hp: 100, hunger: 100, thirst: 100 } },
  Soporte: { maxWeight: 45, initialVitals: { hp: 120, hunger: 100, thirst: 100 } },
  Cocinero: { maxWeight: 40, initialVitals: { hp: 100, hunger: 100, thirst: 100 } }
};

const ITEM_WEIGHTS = { vendas: 0.5, madera: 2.5, chatarra: 1.5, comida: 1.0 };
const roomsData = {};

function calculateWeightAndUpdateStatus(player, roomData) {
  let totalWeight = 0;
  for (const [item, quantity] of Object.entries(player.inventory)) {
    totalWeight += ((ITEM_WEIGHTS[item] || 0) * quantity);
  }
  player.currentWeight = totalWeight;

  if (player.currentWeight > player.maxWeight) {
    if (player.status !== 'Sobrecargado') {
      player.status = 'Sobrecargado';
      roomData.log.push(`[ALERTA] ${player.username} está SOBRECARGADO. Movimiento penalizado.`);
    }
  } else if (player.status === 'Sobrecargado') {
    player.status = 'A Salvo'; 
    roomData.log.push(`[SISTEMA] ${player.username} ha soltado peso y vuelve a estar A Salvo.`);
  }
}

io.on('connection', (socket) => {
  socket.on('transfer_item', ({ room, targetId, item, amount }) => {
    const roomInfo = roomsData[room];
    if (!roomInfo) return;

    const sender = roomInfo.players[socket.id];
    const target = roomInfo.players[targetId];

    if (!sender || !target || sender.id === target.id) return;
    
    const transferAmount = parseInt(amount);
    if (isNaN(transferAmount) || transferAmount <= 0) return;

    if ((sender.inventory[item] || 0) >= transferAmount) {
      sender.inventory[item] -= transferAmount;
      target.inventory[item] = (target.inventory[item] || 0) + transferAmount;

      calculateWeightAndUpdateStatus(sender, roomInfo);
      calculateWeightAndUpdateStatus(target, roomInfo);

      roomInfo.log.push(`[INTERCAMBIO] ${sender.username} transfirió ${transferAmount}x ${item} a ${target.username}.`);
      io.to(room).emit('room_state_update', roomInfo);
    } else {
      roomInfo.log.push(`[ERROR] ${sender.username} intentó enviar ${item} pero no tiene suficiente.`);
      io.to(room).emit('room_state_update', roomInfo);
    }
  });

  console.log(`📡 Dispositivo conectado: ${socket.id}`);

  socket.on('send_message', ({ room, username, message }) => {
    if (!roomsData[room]) return;
    if (!roomsData[room].chat) roomsData[room].chat = [];

    const cleanMessage = message.trim();
    if (!cleanMessage) return;

    const chatEntry = {
      id: Date.now() + Math.random(),
      username,
      text: cleanMessage,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    roomsData[room].chat.push(chatEntry);
    if (roomsData[room].chat.length > 50) {
      roomsData[room].chat.shift();
    }

    io.to(room).emit('room_state_update', roomsData[room]);
  });

  socket.on('join_room', ({ room, username, role }) => {
    socket.join(room);
    if (!roomsData[room]) roomsData[room] = { players: {}, log: [], chat: [] };

    // Limpieza de sesiones previas con el mismo nombre de usuario para evitar duplicados en la sala[cite: 5]
    for (const [existingId, existingPlayer] of Object.entries(roomsData[room].players)) {
      if (existingPlayer.username === username) {
        delete roomsData[room].players[existingId];
      }
    }

    const playerRole = role || 'Soporte';
    
    const playerInventory = playerRole === 'Recolector' ? { vendas: 1, madera: 3, chatarra: 8, comida: 1 } :
                           playerRole === 'Soporte' ? { vendas: 2, madera: 5, chatarra: 5, comida: 2 } :
                           playerRole === 'Medico' ? { vendas: 5, madera: 2, chatarra: 2, comida: 2 } :
                           playerRole === 'Cocinero' ? { vendas: 1, madera: 2, chatarra: 4, comida: 5 } :
                           { vendas: 2, madera: 3, chatarra: 3, comida: 2 };

    roomsData[room].players[socket.id] = {
      id: socket.id,
      username,
      role: playerRole,
      status: 'A Salvo',
      vitals: { ...ROLE_STATS[playerRole].initialVitals },
      inventory: playerInventory,
      currentWeight: 0,
      maxWeight: ROLE_STATS[playerRole].maxWeight
    };

    calculateWeightAndUpdateStatus(roomsData[room].players[socket.id], roomsData[room]);
    roomsData[room].log.push(`[SISTEMA] ${username} se unió como ${playerRole}.`);
    io.to(room).emit('room_state_update', roomsData[room]);
  });

  socket.on('update_inventory', ({ room, item, amount }) => {
    if (roomsData[room] && roomsData[room].players[socket.id]) {
      const player = roomsData[room].players[socket.id];
      player.inventory[item] = amount;
      calculateWeightAndUpdateStatus(player, roomsData[room]);
      roomsData[room].log.push(`[INVENTARIO] ${player.username} tiene ${amount} de ${item}.`);
      io.to(room).emit('room_state_update', roomsData[room]);
    }
  });

  socket.on('update_vital', ({ room, playerId, vitalType, amount }) => {
    if (roomsData[room] && roomsData[room].players[playerId]) {
      const target = roomsData[room].players[playerId];
      target.vitals[vitalType] = Math.max(0, Math.min(100, target.vitals[vitalType] + amount));
      io.to(room).emit('room_state_update', roomsData[room]);
    }
  });

  socket.on('update_status', ({ room, status }) => {
    if (roomsData[room] && roomsData[room].players[socket.id]) {
      roomsData[room].players[socket.id].status = status;
      roomsData[room].log.push(`[ESTADO] ${roomsData[room].players[socket.id].username} ahora está: ${status}`);
      io.to(room).emit('room_state_update', roomsData[room]);
    }
  });

  socket.on('use_role_ability', ({ room, action, targetId }) => {
    const roomInfo = roomsData[room];
    if (!roomInfo) return;
    
    const player = roomInfo.players[socket.id];
    if (!player) return;

    if (action === 'heal' && player.role === 'Medico' && targetId) {
      if (player.inventory.vendas >= 1) {
        player.inventory.vendas -= 1;
        const target = roomInfo.players[targetId];
        target.vitals.hp = Math.min(100, target.vitals.hp + 40);
        calculateWeightAndUpdateStatus(player, roomInfo);
        roomInfo.log.push(`[MÉDICO] ${player.username} usó 1 Venda para curar a ${target.username}.`);
      } else {
        roomInfo.log.push(`[ERROR] ${player.username} intentó curar pero no tiene vendas.`);
      }
    } 
    else if (action === 'cook' && player.role === 'Cocinero') {
      if ((player.inventory.chatarra || 0) >= 2) {
        player.inventory.chatarra -= 2;
        const target = targetId ? roomInfo.players[targetId] : player;
        if (target) {
          target.vitals.hunger = Math.min(100, target.vitals.hunger + 35);
          target.vitals.thirst = Math.min(100, target.vitals.thirst + 35);
          if (targetId) calculateWeightAndUpdateStatus(target, roomInfo);
        }
        calculateWeightAndUpdateStatus(player, roomInfo);
        roomInfo.log.push(`[COCINERO] ${player.username} preparó una ración nutritiva para ${target ? target.username : player.username}.`);
      } else {
        roomInfo.log.push(`[ERROR] ${player.username} necesita al menos 2 de chatarra para cocinar.`);
      }
    }
    else if (action === 'scavenge' && player.role === 'Recolector') {
      if (player.vitals.hunger >= 15 && player.vitals.thirst >= 15) {
        player.vitals.hunger -= 15;
        player.vitals.thirst -= 15;
        const lootPool = ['madera', 'chatarra', 'comida', 'vendas'];
        const foundItem = lootPool[Math.floor(Math.random() * lootPool.length)];
        const qty = Math.floor(Math.random() * 3) + 1;
        
        player.inventory[foundItem] = (player.inventory[foundItem] || 0) + qty;
        calculateWeightAndUpdateStatus(player, roomInfo);
        roomInfo.log.push(`[RECOLECCIÓN] ${player.username} gastó energía y encontró ${qty}x ${foundItem}.`);
      } else {
        roomInfo.log.push(`[ERROR] ${player.username} está muy hambriento/sediento para explorar.`);
      }
    }
    else if (action === 'barricade' && player.role === 'Soporte') {
      if (player.inventory.madera >= 3 && player.inventory.chatarra >= 2) {
        player.inventory.madera -= 3;
        player.inventory.chatarra -= 2;
        calculateWeightAndUpdateStatus(player, roomInfo);
        
        Object.values(roomInfo.players).forEach(p => {
          if(p.status !== 'Muerto' && p.status !== 'Sobrecargado') p.status = 'A Salvo';
        });
        roomInfo.log.push(`[SOPORTE] ${player.username} construyó una Barricada. El equipo está A Salvo.`);
      } else {
        roomInfo.log.push(`[ERROR] ${player.username} no tiene materiales (3 madera, 2 chatarra) para la barricada.`);
      }
    }
    
    io.to(room).emit('room_state_update', roomInfo);
  });

  socket.on('disconnect', () => {
    for (const room in roomsData) {
      if (roomsData[room].players[socket.id]) {
        const username = roomsData[room].players[socket.id].username;
        delete roomsData[room].players[socket.id];
        roomsData[room].log.push(`[SISTEMA] ${username} se desconectó.`);
        io.to(room).emit('room_state_update', roomsData[room]);
        break; 
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => { 
  console.log(`🚀 Backend de SquadSync corriendo en el puerto ${PORT}`); 
});