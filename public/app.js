const socket = io();
let myPlayerId = null;
let currentRoomId = null;
let isHost = false;
let gameState = null;
let myPrivateState = null;

// 界面切换
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// 弹窗工具
function showModal(title, bodyHtml, onConfirm) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('commonModal').classList.add('active');
  
  document.getElementById('modalCancel').onclick = () => {
    document.getElementById('commonModal').classList.remove('active');
  };
  document.getElementById('modalConfirm').onclick = () => {
    document.getElementById('commonModal').classList.remove('active');
    if (onConfirm) onConfirm();
  };
}

// ========== 大厅逻辑 ==========
document.getElementById('btnCreate').addEventListener('click', () => {
  const name = document.getElementById('playerName').value.trim();
  if (!name) return alert('请输入昵称');
  socket.emit('create_room', name, (res) => {
    if (res.success) {
      myPlayerId = res.playerId;
      currentRoomId = res.roomId;
      isHost = res.isHost;
      showScreen('roomWait');
      document.getElementById('roomIdDisplay').textContent = res.roomId;
      document.getElementById('btnStart').style.display = 'block';
      document.getElementById('waitTip').style.display = 'none';
    }
  });
});

document.getElementById('btnJoin').addEventListener('click', () => {
  const name = document.getElementById('playerName').value.trim();
  const roomId = document.getElementById('roomIdInput').value.trim();
  if (!name || !roomId) return alert('请输入昵称和房间号');
  socket.emit('join_room', { roomId, playerName: name }, (res) => {
    if (!res.success) return alert(res.msg);
    myPlayerId = res.playerId;
    currentRoomId = res.roomId;
    isHost = res.isHost;
    showScreen('roomWait');
    document.getElementById('roomIdDisplay').textContent = res.roomId;
    document.getElementById('btnStart').style.display = 'none';
    document.getElementById('waitTip').style.display = 'block';
  });
});

// 房间更新
socket.on('room_update', (data) => {
  const list = document.getElementById('playerList');
  list.innerHTML = '';
  data.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name}</span><span>${p.isHost ? '房主' : ''}</span>`;
    list.appendChild(li);
  });
});

// 开始游戏按钮
document.getElementById('btnStart').addEventListener('click', () => {
  socket.emit('start_game', currentRoomId, (res) => {
    if (!res.success) alert(res.msg);
  });
});

// 游戏开始
socket.on('game_start', (state) => {
  gameState = state;
  showScreen('gameScreen');
  renderGame();
});

// 状态更新
socket.on('state_update', (state) => {
  gameState = state;
  renderGame();
  if (state.gameOver) {
    document.getElementById('winnerText').textContent = `游戏结束！${state.winner} 获胜！`;
    document.getElementById('gameOverModal').classList.add('active');
  }
});

// 私有状态更新
socket.on('private_state', (state) => {
  myPrivateState = state;
  renderMyInfo();
});

// ========== 游戏渲染 ==========
function renderGame() {
  if (!gameState) return;
  
  document.getElementById('currentTurn').textContent = gameState.currentTurnName;
  document.getElementById('publicGun').textContent = gameState.publicGunAvailable ? '可用' : '已被拿走';

  // 玩家列表
  const statusList = document.getElementById('playerStatusList');
  statusList.innerHTML = '';
  gameState.players.forEach(p => {
    const div = document.createElement('div');
    div.className = `player-item ${p.isAlive ? '' : 'dead'} ${p.id === gameState.currentTurnId ? 'current' : ''}`;
    
    let statusText = p.isAlive ? '存活' : '淘汰';
    if (p.hasGun) statusText += ' | 持枪';
    if (p.isInjured) statusText += ' | 受伤';
    if (p.hasEquipment) statusText += ' | 有装备';
    
    div.innerHTML = `
      <div class="name">${p.name}</div>
      <div class="status">${statusText}</div>
    `;
    statusList.appendChild(div);
  });

  // 日志
  const logBox = document.getElementById('gameLog');
  logBox.innerHTML = '';
  gameState.logs.forEach(log => {
    const p = document.createElement('p');
    p.textContent = log;
    logBox.appendChild(p);
  });
  logBox.scrollTop = logBox.scrollHeight;

  // 行动按钮权限
  const isMyTurn = gameState.currentTurnId === myPlayerId;
  document.querySelectorAll('.action-btns button').forEach(btn => {
    btn.disabled = !isMyTurn;
  });
}

function renderMyInfo() {
  if (!myPrivateState) return;
  
  // 我的身份牌
  const cardsDiv = document.getElementById('myCards');
  cardsDiv.innerHTML = '';
  myPrivateState.myCards.forEach((card, idx) => {
    const div = document.createElement('div');
    let cls = 'card-item';
    if (card.type === '警察') cls += ' cop';
    else if (card.type === '匪徒') cls += ' criminal';
    else if (card.type === '探长') cls += ' inspector';
    else if (card.type === '主谋') cls += ' boss';
    div.className = cls;
    div.textContent = card.type + (card.isFlipped ? ' (反)' : '');
    cardsDiv.appendChild(div);
  });

  // 阵营
  const camp = myPrivateState.myCamp;
  document.getElementById('myCamp').textContent = 
    `阵营：${camp.camp} ${camp.isLeader ? '（首领）' : ''}`;

  // 装备
  const equipDiv = document.getElementById('myEquipment');
  equipDiv.textContent = myPrivateState.myEquipment 
    ? `装备：${myPrivateState.myEquipment.name} - ${myPrivateState.myEquipment.desc}`
    : '';
}

// ========== 行动按钮 ==========
document.querySelectorAll('[data-action]').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    handleAction(action);
  });
});

function handleAction(action) {
  const alivePlayers = gameState.players.filter(p => p.isAlive && p.id !== myPlayerId);
  
  switch (action) {
    case 'investigate': {
      const options = alivePlayers.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
      const html = `
        <p>选择调查目标：</p>
        <select id="targetSelect" style="width:100%;padding:8px;margin:8px 0;">${options}</select>
        <p>选择查看第几张牌：</p>
        <select id="cardIndex" style="width:100%;padding:8px;margin:8px 0;">
          <option value="0">第1张</option>
          <option value="1">第2张</option>
          <option value="2">第3张</option>
        </select>
      `;
      showModal('调查身份', html, () => {
        const targetId = document.getElementById('targetSelect').value;
        const cardIndex = parseInt(document.getElementById('cardIndex').value);
        socket.emit('do_action', {
          roomId: currentRoomId,
          action: 'investigate',
          params: { targetId, cardIndex }
        }, (res) => {
          alert(res.msg);
        });
      });
      break;
    }

    case 'draw_equipment': {
      socket.emit('do_action', {
        roomId: currentRoomId,
        action: 'draw_equipment',
        params: {}
      }, (res) => {
        alert(res.msg);
      });
      break;
    }

    case 'take_gun': {
      if (!gameState.publicGunAvailable) return alert('公共区没有手枪');
      const options = alivePlayers.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
      const html = `
        <p>选择瞄准目标：</p>
        <select id="targetSelect" style="width:100%;padding:8px;margin:8px 0;">${options}</select>
      `;
      showModal('拿枪瞄准', html, () => {
        const targetId = document.getElementById('targetSelect').value;
        socket.emit('do_action', {
          roomId: currentRoomId,
          action: 'take_gun',
          params: { targetId }
        }, (res) => {
          alert(res.msg);
        });
      });
      break;
    }

    case 'shoot': {
      const me = gameState.players.find(p => p.id === myPlayerId);
      if (!me.hasGun) return alert('你没有手枪');
      if (myPrivateState.justGotGun) return alert('刚拿到枪本回合不能射击');
      const target = gameState.players.find(p => p.id === me.aimTarget);
      showModal('开枪确认', `<p>确定要射击 ${target.name} 吗？</p>`, () => {
        socket.emit('do_action', {
          roomId: currentRoomId,
          action: 'shoot',
          params: {}
        }, (res) => {
          alert(res.msg);
        });
      });
      break;
    }

    case 'use_equipment': {
      if (!myPrivateState.myEquipment) return alert('你没有装备牌');
      const equip = myPrivateState.myEquipment;
      
      // 简单处理：单目标装备通用弹窗
      const needsTarget = ['med_kit', 'k9_unit', 'truth_serum', 'polygraph', 
                           'planted_evidence', 'flashbang', 'defibrillator',
                           'surveillance_camera', 'taser', 'walkie_talkie'];
      
      if (needsTarget.includes(equip.id)) {
        const options = gameState.players.filter(p => p.isAlive || equip.id === 'defibrillator')
          .map(p => `<option value="${p.id}">${p.name}</option>`).join('');
        let extra = '';
        if (['truth_serum', 'planted_evidence', 'surveillance_camera'].includes(equip.id)) {
          extra = `<p>选择第几张牌：</p>
            <select id="cardIndex" style="width:100%;padding:8px;margin:8px 0;">
              <option value="0">第1张</option>
              <option value="1">第2张</option>
              <option value="2">第3张</option>
            </select>`;
        }
        if (equip.id === 'taser') {
          extra = `<p>抢夺后瞄准谁：</p>
            <select id="newAimId" style="width:100%;padding:8px;margin:8px 0;">${options}</select>`;
        }
        
        const html = `<p>选择目标：</p>
          <select id="targetSelect" style="width:100%;padding:8px;margin:8px 0;">${options}</select>${extra}`;
        
        showModal(`使用 ${equip.name}`, html, () => {
          const targetId = document.getElementById('targetSelect').value;
          const params = { targetId };
          if (document.getElementById('cardIndex')) {
            params.cardIndex = parseInt(document.getElementById('cardIndex').value);
          }
          if (document.getElementById('newAimId')) {
            params.newAimId = document.getElementById('newAimId').value;
          }
          socket.emit('do_action', {
            roomId: currentRoomId,
            action: 'use_equipment',
            params
          }, (res) => {
            alert(res.msg);
          });
        });
      } else if (equip.id === 'blackmail' || equip.id === 'wiretap') {
        const options = gameState.players.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
        const html = `
          <p>玩家1：</p><select id="p1" style="width:100%;padding:8px;margin:4px 0;">${options}</select>
          <p>玩家1 第几张：</p><select id="i1" style="width:100%;padding:8px;margin:4px 0;">
            <option value="0">第1张</option><option value="1">第2张</option><option value="2">第3张</option>
          </select>
          <p>玩家2：</p><select id="p2" style="width:100%;padding:8px;margin:4px 0;">${options}</select>
          <p>玩家2 第几张：</p><select id="i2" style="width:100%;padding:8px;margin:4px 0;">
            <option value="0">第1张</option><option value="1">第2张</option><option value="2">第3张</option>
          </select>
        `;
        showModal(`使用 ${equip.name}`, html, () => {
          const p1 = document.getElementById('p1').value;
          const i1 = parseInt(document.getElementById('i1').value);
          const p2 = document.getElementById('p2').value;
          const i2 = parseInt(document.getElementById('i2').value);
          const params = equip.id === 'blackmail' 
            ? { player1Id: p1, index1: i1, player2Id: p2, index2: i2 }
            : { target1Id: p1, index1: i1, target2Id: p2, index2: i2 };
          socket.emit('do_action', {
            roomId: currentRoomId,
            action: 'use_equipment',
            params
          }, (res) => {
            alert(res.msg);
          });
        });
      } else {
        // 无参数装备直接用
        socket.emit('do_action', {
          roomId: currentRoomId,
          action: 'use_equipment',
          params: {}
        }, (res) => {
          alert(res.msg);
        });
      }
      break;
    }
  }
}

// 结束回合
document.getElementById('btnEndTurn').addEventListener('click', () => {
  // 规则检查：上回合瞄准未射击必须换目标
  const me = gameState.players.find(p => p.id === myPlayerId);
  if (me.hasGun && !myPrivateState.justGotGun) {
    const alivePlayers = gameState.players.filter(p => p.isAlive && p.id !== myPlayerId);
    const options = alivePlayers.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    showModal('更换瞄准目标', 
      '<p>规则：上回合瞄准未射击，本回合必须更换瞄准目标</p>' +
      `<select id="newAim" style="width:100%;padding:8px;margin:8px 0;">${options}</select>`,
      () => {
        const newAim = document.getElementById('newAim').value;
        socket.emit('do_action', {
          roomId: currentRoomId,
          action: 'change_aim',
          params: { targetId: newAim }
        }, () => {
          socket.emit('end_turn', currentRoomId);
        });
      }
    );
    return;
  }
  socket.emit('end_turn', currentRoomId);
});
