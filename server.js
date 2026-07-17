const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 静态文件托管
app.use(express.static(path.join(__dirname, 'public')));

// ===================== 游戏核心枚举 =====================
const IdentityType = {
  COP: '警察',
  CRIMINAL: '匪徒',
  INSPECTOR: '探长',
  BOSS: '主谋'
};

const Camp = {
  POLICE: '警察阵营',
  CRIMINAL: '匪徒阵营'
};

// 装备牌配置
const EQUIPMENT_LIST = [
  { id: 'bribe', name: '贿赂', desc: '秘密查看目标一张身份牌' },
  { id: 'planted_evidence', name: '栽赃证据', desc: '反转目标一张普通身份牌阵营' },
  { id: 'surveillance_camera', name: '监控摄像头', desc: '永久公开目标一张身份牌' },
  { id: 'taser', name: '电击枪', desc: '抢夺他人手枪并瞄准，本回合不能射击' },
  { id: 'walkie_talkie', name: '对讲机', desc: '令所有持枪玩家转向同一目标' },
  { id: 'truth_serum', name: '吐真剂', desc: '永久公开目标一张暗置身份牌' },
  { id: 'med_kit', name: '医疗包', desc: '移除首领的受伤标记' },
  { id: 'k9_unit', name: '警犬队', desc: '缴械一名持枪玩家' },
  { id: 'polygraph', name: '测谎仪', desc: '秘密查看目标全部三张身份牌' },
  { id: 'defibrillator', name: '除颤仪', desc: '复活一名已淘汰的普通玩家' },
  { id: 'flashbang', name: '闪光弹', desc: '打乱目标三张身份牌顺序' },
  { id: 'smoke_grenade', name: '烟雾弹', desc: '永久反转回合行动顺序' },
  { id: 'bulletproof_vest', name: '防弹背心', desc: '免疫一次射击伤害' },
  { id: 'blackmail', name: '勒索信', desc: '交换两名玩家各一张身份牌' },
  { id: 'coffee', name: '咖啡', desc: '直接跳到你的下一个回合' },
  { id: 'wiretap', name: '窃听器', desc: '分别查看两名玩家各一张身份牌' }
];

// ===================== 游戏引擎类 =====================
class GameEngine {
  constructor(playerList) {
    this.players = playerList.map((p, i) => ({
      id: p.id,
      name: p.name,
      socketId: p.socketId,
      identityCards: [],
      equipment: null,
      hasGun: false,
      aimTarget: null,
      isInjured: false,
      isAlive: true,
      justGotGun: false
    }));
    this.playerCount = this.players.length;
    this.publicGunAvailable = true;
    this.currentTurnIndex = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnDirection = 1;
    this.logs = [];

    this._initIdentityCards();
    this._initEquipmentDeck();
    this._addLog('游戏开始！身份已暗置发放');
  }

  // 初始化身份牌并发牌
  _initIdentityCards() {
    const total = this.playerCount * 3;
    const deck = [
      { type: IdentityType.INSPECTOR, isRevealed: false, isFlipped: false },
      { type: IdentityType.BOSS, isRevealed: false, isFlipped: false }
    ];
    const remaining = total - 2;
    const half = Math.floor(remaining / 2);
    for (let i = 0; i < half; i++) deck.push({ type: IdentityType.COP, isRevealed: false, isFlipped: false });
    for (let i = 0; i < remaining - half; i++) deck.push({ type: IdentityType.CRIMINAL, isRevealed: false, isFlipped: false });
    
    // 洗牌
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    this.players.forEach((p, idx) => {
      p.identityCards = deck.slice(idx * 3, (idx + 1) * 3);
    });
  }

  // 初始化装备牌堆
  _initEquipmentDeck() {
    this.equipmentDeck = [...EQUIPMENT_LIST];
    for (let i = this.equipmentDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.equipmentDeck[i], this.equipmentDeck[j]] = [this.equipmentDeck[j], this.equipmentDeck[i]];
    }
  }

  _drawEquipment() {
    const card = this.equipmentDeck.shift();
    this.equipmentDeck.push(card); // 用完放回牌堆底
    return { ...card };
  }

  _addLog(msg) {
    this.logs.push(msg);
    if (this.logs.length > 50) this.logs.shift();
  }

  getPlayerById(id) {
    return this.players.find(p => p.id === id);
  }

  // 计算玩家阵营和是否为首领
  getPlayerCamp(player) {
    for (const card of player.identityCards) {
      if (card.type === IdentityType.INSPECTOR) return { camp: Camp.POLICE, isLeader: true };
      if (card.type === IdentityType.BOSS) return { camp: Camp.CRIMINAL, isLeader: true };
    }
    let policeCnt = 0;
    player.identityCards.forEach(card => {
      let actual = card.type === IdentityType.COP ? Camp.POLICE : Camp.CRIMINAL;
      if (card.isFlipped && card.type !== IdentityType.INSPECTOR && card.type !== IdentityType.BOSS) {
        actual = actual === Camp.POLICE ? Camp.CRIMINAL : Camp.POLICE;
      }
      if (actual === Camp.POLICE) policeCnt++;
    });
    return {
      camp: policeCnt > 1.5 ? Camp.POLICE : Camp.CRIMINAL,
      isLeader: false
    };
  }

  // 检查游戏结束
  _checkGameEnd() {
    let inspectorAlive = false;
    let bossAlive = false;
    this.players.forEach(p => {
      if (!p.isAlive) return;
      const { camp, isLeader } = this.getPlayerCamp(p);
      if (isLeader) {
        if (camp === Camp.POLICE) inspectorAlive = true;
        else bossAlive = true;
      }
    });

    if (!inspectorAlive) {
      this.gameOver = true;
      this.winner = Camp.CRIMINAL;
      this._addLog(`游戏结束！${Camp.CRIMINAL}获胜！`);
      return true;
    }
    if (!bossAlive) {
      this.gameOver = true;
      this.winner = Camp.POLICE;
      this._addLog(`游戏结束！${Camp.POLICE}获胜！`);
      return true;
    }
    return false;
  }

  // 跳到下一个存活玩家回合
  nextTurn() {
    if (this.gameOver) return;
    do {
      this.currentTurnIndex = (this.currentTurnIndex + this.turnDirection + this.playerCount) % this.playerCount;
    } while (!this.players[this.currentTurnIndex].isAlive);
    this.currentPlayer.justGotGun = false;
  }

  get currentPlayer() {
    return this.players[this.currentTurnIndex];
  }

  // === 四大基础行动 ===
  actInvestigate(actorId, targetId, cardIndex) {
    const actor = this.getPlayerById(actorId);
    const target = this.getPlayerById(targetId);
    if (!actor || !target || !target.isAlive) return { success: false, msg: '无效目标' };
    if (cardIndex < 0 || cardIndex >= 3) return { success: false, msg: '卡牌位置无效' };
    const card = target.identityCards[cardIndex];
    this._addLog(`${actor.name} 调查了 ${target.name} 的一张身份牌`);
    return { success: true, msg: `第${cardIndex+1}张牌是【${card.type}】`, cardType: card.type };
  }

  actDrawEquipment(actorId) {
    const actor = this.getPlayerById(actorId);
    if (!actor) return { success: false, msg: '无效玩家' };
    const newCard = this._drawEquipment();
    const oldCard = actor.equipment;
    actor.equipment = newCard;
    this._addLog(`${actor.name} 抽取了一张装备牌`);
    return {
      success: true,
      msg: oldCard ? `抽到【${newCard.name}】，丢弃了【${oldCard.name}】` : `抽到【${newCard.name}】`,
      equipment: newCard
    };
  }

  actTakeGun(actorId, targetId) {
    const actor = this.getPlayerById(actorId);
    const target = this.getPlayerById(targetId);
    if (!actor || !target || !target.isAlive) return { success: false, msg: '无效目标' };
    if (actor.hasGun) return { success: false, msg: '你已经持有手枪' };
    if (!this.publicGunAvailable) return { success: false, msg: '公共区没有手枪' };

    this.publicGunAvailable = false;
    actor.hasGun = true;
    actor.aimTarget = targetId;
    actor.justGotGun = true;
    this._addLog(`${actor.name} 拿起手枪，瞄准了 ${target.name}`);
    return { success: true, msg: `你已持枪，当前瞄准目标：${target.name}` };
  }

  actShoot(actorId) {
    const actor = this.getPlayerById(actorId);
    if (!actor || !actor.hasGun || actor.aimTarget === null) {
      return { success: false, msg: '无枪或无瞄准目标' };
    }
    const target = this.getPlayerById(actor.aimTarget);
    if (!target || !target.isAlive) return { success: false, msg: '目标已淘汰' };

    // 检查防弹背心
    if (target.equipment && target.equipment.id === 'bulletproof_vest') {
      target.equipment = null;
      actor.hasGun = false;
      actor.aimTarget = null;
      this.publicGunAvailable = true;
      this._addLog(`${target.name} 用防弹背心免疫了射击！`);
      return { success: true, msg: '对方使用防弹背心免疫了伤害！' };
    }

    const { isLeader } = this.getPlayerCamp(target);
    let died = false;
    if (isLeader) {
      if (!target.isInjured) {
        target.isInjured = true;
        this._addLog(`枪响！${target.name} 中弹受伤，但仍未倒下`);
      } else {
        target.isAlive = false;
        died = true;
        this._addLog(`枪响！${target.name} 被淘汰出局`);
      }
    } else {
      target.isAlive = false;
      died = true;
      this._addLog(`枪响！${target.name} 被淘汰出局`);
    }

    actor.hasGun = false;
    actor.aimTarget = null;
    this.publicGunAvailable = true;

    this._checkGameEnd();
    return { success: true, msg: died ? `${target.name} 被淘汰！` : `${target.name} 受伤了！`, died };
  }

  // 更换瞄准目标
  changeAim(actorId, targetId) {
    const actor = this.getPlayerById(actorId);
    const target = this.getPlayerById(targetId);
    if (!actor || !actor.hasGun || !target || !target.isAlive) {
      return { success: false, msg: '操作无效' };
    }
    actor.aimTarget = targetId;
    this._addLog(`${actor.name} 更换了瞄准目标`);
    return { success: true, msg: `已更换瞄准目标为 ${target.name}` };
  }

  // === 装备牌效果 ===
  useEquipment(actorId, params) {
    const actor = this.getPlayerById(actorId);
    if (!actor || !actor.equipment) return { success: false, msg: '没有可用装备' };
    const eid = actor.equipment.id;
    let result = { success: true, msg: '' };

    switch (eid) {
      case 'med_kit': {
        const target = this.getPlayerById(params.targetId);
        if (!target || !target.isAlive) return { success: false, msg: '目标无效' };
        const { isLeader } = this.getPlayerCamp(target);
        if (!isLeader || !target.isInjured) return { success: false, msg: '只能对受伤首领使用' };
        target.isInjured = false;
        result.msg = `医疗包生效，${target.name} 恢复状态`;
        this._addLog(`${target.name} 使用医疗包恢复了状态`);
        break;
      }
      case 'k9_unit': {
        const target = this.getPlayerById(params.targetId);
        if (!target || !target.hasGun) return { success: false, msg: '目标未持枪' };
        target.hasGun = false;
        target.aimTarget = null;
        this.publicGunAvailable = true;
        result.msg = `警犬队缴械了 ${target.name}`;
        this._addLog(`${target.name} 被警犬队缴械`);
        break;
      }
      case 'truth_serum':
      case 'surveillance_camera': {
        const target = this.getPlayerById(params.targetId);
        const idx = params.cardIndex;
        if (!target || idx < 0 || idx >= 3) return { success: false, msg: '参数无效' };
        target.identityCards[idx].isRevealed = true;
        result.msg = `${target.name} 第${idx+1}张牌被公开：${target.identityCards[idx].type}`;
        this._addLog(`一张身份牌被公开`);
        break;
      }
      case 'smoke_grenade': {
        this.turnDirection *= -1;
        const dir = this.turnDirection === 1 ? '顺时针' : '逆时针';
        result.msg = `烟雾弹生效！回合顺序改为${dir}`;
        this._addLog(`回合顺序反转`);
        break;
      }
      case 'polygraph': {
        const target = this.getPlayerById(params.targetId);
        if (!target) return { success: false, msg: '目标无效' };
        const cards = target.identityCards.map(c => c.type);
        result.msg = `${target.name} 的三张牌：${cards.join('、')}`;
        result.privateInfo = cards;
        this._addLog(`${actor.name} 使用了测谎仪`);
        break;
      }
      case 'planted_evidence': {
        const target = this.getPlayerById(params.targetId);
        const idx = params.cardIndex;
        if (!target || idx < 0 || idx >= 3) return { success: false, msg: '参数无效' };
        const card = target.identityCards[idx];
        if (card.type === IdentityType.INSPECTOR || card.type === IdentityType.BOSS) {
          return { success: false, msg: '不能对首领牌使用' };
        }
        card.isFlipped = !card.isFlipped;
        result.msg = `栽赃成功，${target.name} 第${idx+1}张牌阵营反转`;
        this._addLog(`有人使用了栽赃证据`);
        break;
      }
      case 'walkie_talkie': {
        const targetId = params.targetId;
        const target = this.getPlayerById(targetId);
        if (!target || !target.isAlive) return { success: false, msg: '目标无效' };
        this.players.forEach(p => {
          if (p.hasGun && p.isAlive) p.aimTarget = targetId;
        });
        result.msg = `所有持枪玩家均转向瞄准 ${target.name}`;
        this._addLog(`对讲机生效，所有枪口转向同一目标`);
        break;
      }
      case 'taser': {
        const target = this.getPlayerById(params.targetId);
        if (!target || !target.hasGun) return { success: false, msg: '目标未持枪' };
        if (actor.hasGun) return { success: false, msg: '你已有枪' };
        const newTarget = this.getPlayerById(params.newAimId);
        if (!newTarget || !newTarget.isAlive) return { success: false, msg: '瞄准目标无效' };
        
        target.hasGun = false;
        target.aimTarget = null;
        actor.hasGun = true;
        actor.aimTarget = params.newAimId;
        actor.justGotGun = true;
        result.msg = `夺枪成功！已瞄准 ${newTarget.name}，本回合不能射击`;
        this._addLog(`${actor.name} 用电击枪抢夺了手枪`);
        break;
      }
      case 'flashbang': {
        const target = this.getPlayerById(params.targetId);
        if (!target) return { success: false, msg: '目标无效' };
        for (let i = target.identityCards.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [target.identityCards[i], target.identityCards[j]] = [target.identityCards[j], target.identityCards[i]];
        }
        result.msg = `${target.name} 的身份牌顺序被打乱`;
        this._addLog(`闪光弹生效`);
        break;
      }
      case 'defibrillator': {
        const target = this.getPlayerById(params.targetId);
        if (!target || target.isAlive) return { success: false, msg: '目标无效' };
        const { isLeader } = this.getPlayerCamp(target);
        if (isLeader) return { success: false, msg: '不能复活首领' };
        target.isAlive = true;
        target.isInjured = false;
        result.msg = `${target.name} 被复活`;
        this._addLog(`${target.name} 被除颤仪复活`);
        break;
      }
      case 'blackmail': {
        const p1 = this.getPlayerById(params.player1Id);
        const p2 = this.getPlayerById(params.player2Id);
        const i1 = params.index1, i2 = params.index2;
        if (!p1 || !p2 || i1 < 0 || i1 >= 3 || i2 < 0 || i2 >= 3) {
          return { success: false, msg: '参数无效' };
        }
        [p1.identityCards[i1], p2.identityCards[i2]] = [p2.identityCards[i2], p1.identityCards[i1]];
        result.msg = '两名玩家的身份牌已互换';
        this._addLog('勒索信生效，身份牌发生互换');
        break;
      }
      case 'coffee': {
        do {
          this.currentTurnIndex = (this.currentTurnIndex + this.turnDirection + this.playerCount) % this.playerCount;
        } while (this.players[this.currentTurnIndex].id !== actorId);
        result.msg = '咖啡生效！直接轮到你的下回合';
        this._addLog(`${actor.name} 使用了咖啡`);
        break;
      }
      case 'wiretap': {
        const t1 = this.getPlayerById(params.target1Id);
        const t2 = this.getPlayerById(params.target2Id);
        const i1 = params.index1, i2 = params.index2;
        if (!t1 || !t2 || i1 < 0 || i1 >= 3 || i2 < 0 || i2 >= 3) {
          return { success: false, msg: '参数无效' };
        }
        result.msg = `${t1.name}第${i1+1}张：${t1.identityCards[i1].type}；${t2.name}第${i2+1}张：${t2.identityCards[i2].type}`;
        this._addLog(`${actor.name} 使用了窃听器`);
        break;
      }
      case 'bribe': {
        const target = this.getPlayerById(params.targetId);
        const idx = params.cardIndex;
        if (!target || idx < 0 || idx >= 3) return { success: false, msg: '参数无效' };
        result.msg = `对方第${idx+1}张牌是【${target.identityCards[idx].type}】`;
        this._addLog(`${actor.name} 使用了贿赂`);
        break;
      }
      default:
        return { success: false, msg: '未知装备' };
    }

    // 消耗装备
    actor.equipment = null;
    this._checkGameEnd();
    return result;
  }

  // 获取公共状态（给所有玩家）
  getPublicState() {
    return {
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        isAlive: p.isAlive,
        hasGun: p.hasGun,
        aimTarget: p.aimTarget,
        isInjured: p.isInjured,
        revealedCards: p.identityCards.map(c => c.isRevealed ? c.type : null),
        hasEquipment: !!p.equipment
      })),
      currentTurnId: this.currentPlayer.id,
      currentTurnName: this.currentPlayer.name,
      publicGunAvailable: this.publicGunAvailable,
      gameOver: this.gameOver,
      winner: this.winner,
      logs: this.logs.slice(-10)
    };
  }

  // 获取玩家私有状态（仅发给对应玩家）
  getPrivateState(playerId) {
    const player = this.getPlayerById(playerId);
    if (!player) return null;
    return {
      myCards: player.identityCards.map(c => ({ type: c.type, isFlipped: c.isFlipped })),
      myEquipment: player.equipment,
      myCamp: this.getPlayerCamp(player),
      justGotGun: player.justGotGun
    };
  }
}

// ===================== 房间管理 =====================
const rooms = new Map(); // roomId -> { game: GameEngine, players: [] }

function generateRoomId() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// ===================== Socket 事件处理 =====================
io.on('connection', (socket) => {
  console.log('玩家连接:', socket.id);

  // 创建房间
  socket.on('create_room', (playerName, callback) => {
    const roomId = generateRoomId();
    const player = { id: socket.id, name: playerName, socketId: socket.id, isHost: true };
    rooms.set(roomId, {
      game: null,
      players: [player],
      status: 'waiting' // waiting / playing
    });
    socket.join(roomId);
    callback({ success: true, roomId, playerId: socket.id, isHost: true });
    io.to(roomId).emit('room_update', {
      players: rooms.get(roomId).players,
      status: 'waiting'
    });
  });

  // 加入房间
  socket.on('join_room', ({ roomId, playerName }, callback) => {
    roomId = roomId.toUpperCase();
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, msg: '房间不存在' });
    if (room.status === 'playing') return callback({ success: false, msg: '游戏已开始' });
    if (room.players.length >= 8) return callback({ success: false, msg: '房间已满（最多8人）' });

    const player = { id: socket.id, name: playerName, socketId: socket.id, isHost: false };
    room.players.push(player);
    socket.join(roomId);
    callback({ success: true, roomId, playerId: socket.id, isHost: false });
    io.to(roomId).emit('room_update', {
      players: room.players,
      status: 'waiting'
    });
  });

  // 开始游戏
  socket.on('start_game', (roomId, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, msg: '房间不存在' });
    if (room.players.length < 4) return callback({ success: false, msg: '至少需要4名玩家' });
    
    room.status = 'playing';
    room.game = new GameEngine(room.players);
    
    // 广播游戏开始和公共状态
    io.to(roomId).emit('game_start', room.game.getPublicState());
    
    // 给每个玩家发私有信息
    room.players.forEach(p => {
      io.to(p.socketId).emit('private_state', room.game.getPrivateState(p.id));
    });
    
    callback({ success: true });
  });

  // 执行行动
  socket.on('do_action', ({ roomId, action, params }, callback) => {
    const room = rooms.get(roomId);
    if (!room || !room.game || room.game.gameOver) return callback({ success: false, msg: '游戏未进行' });
    
    const actorId = socket.id;
    if (room.game.currentPlayer.id !== actorId) {
      return callback({ success: false, msg: '还没轮到你的回合' });
    }

    let result;
    switch (action) {
      case 'investigate':
        result = room.game.actInvestigate(actorId, params.targetId, params.cardIndex);
        break;
      case 'draw_equipment':
        result = room.game.actDrawEquipment(actorId);
        break;
      case 'take_gun':
        result = room.game.actTakeGun(actorId, params.targetId);
        break;
      case 'shoot':
        result = room.game.actShoot(actorId);
        break;
      case 'change_aim':
        result = room.game.changeAim(actorId, params.targetId);
        break;
      case 'use_equipment':
        result = room.game.useEquipment(actorId, params);
        break;
      default:
        return callback({ success: false, msg: '未知行动' });
    }

    // 广播公共状态更新
    io.to(roomId).emit('state_update', room.game.getPublicState());
    // 更新玩家私有状态
    room.players.forEach(p => {
      io.to(p.socketId).emit('private_state', room.game.getPrivateState(p.id));
    });

    callback(result);
  });

  // 结束回合
  socket.on('end_turn', (roomId, callback) => {
    const room = rooms.get(roomId);
    if (!room || !room.game) return callback({ success: false });
    if (room.game.currentPlayer.id !== socket.id) {
      return callback({ success: false, msg: '不是你的回合' });
    }
    room.game.nextTurn();
    io.to(roomId).emit('state_update', room.game.getPublicState());
    room.players.forEach(p => {
      io.to(p.socketId).emit('private_state', room.game.getPrivateState(p.id));
    });
    callback({ success: true });
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log('玩家断开:', socket.id);
    // 简单处理：玩家离开不销毁房间，实际可加超时销毁
    for (const [roomId, room] of rooms) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx > -1) {
        room.players.splice(idx, 1);
        io.to(roomId).emit('room_update', {
          players: room.players,
          status: room.status
        });
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
