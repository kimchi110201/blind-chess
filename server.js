const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// 방장이 고를 수 있는 값들 (이 값 외에는 무시해요)
const ALLOWED_MINUTES = [0, 3, 5, 10, 15, 30, 60];   // 0 = 시간 제한 없음
const ALLOWED_INCREMENT = [0, 2, 5, 10];             // 수를 둘 때마다 추가되는 초
const ALLOWED_VIEWS = [0, 1, 2, 3, 5, 10, -1];       // 0 = 불가, -1 = 무제한

// 연결이 끊긴 사람을 기다려주는 시간
const GRACE_PLAYING_MS = 3 * 60 * 1000;   // 게임 중
const GRACE_IDLE_MS = 30 * 60 * 1000;     // 대기 화면 등

// 방 목록:
// { 'K7X2QP': {
//     code, hostId, whiteId, blackId,   (각자의 신분 값 = playerId)
//     sockets: { playerId: 소켓ID 또는 null },
//     grace: { playerId: 타이머 },
//     settings: { minutes, increment, views },
//     game, over, drawOffer, ready, rounds,
//     clock: { w, b }, lastTick, timeoutHandle,
//     viewsLeft: { white, black },
//     lastResult
// } }
const rooms = {};

// ---------- 작은 도우미 함수들 ----------

function makeCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (code.length < 6 || rooms[code]);
  return code;
}

function cleanPid(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

function pick(value, allowed, fallback) {
  const n = Number(value);
  return allowed.includes(n) ? n : fallback;
}

function cleanSettings(raw) {
  const s = raw || {};
  const minutes = pick(s.minutes, ALLOWED_MINUTES, 0);
  return {
    minutes,
    increment: minutes > 0 ? pick(s.increment, ALLOWED_INCREMENT, 0) : 0,
    views: pick(s.views, ALLOWED_VIEWS, 0),
  };
}

function emitTo(room, pid, event, data) {
  const sid = pid && room.sockets[pid];
  if (sid) io.to(sid).emit(event, data);
}

function colorOf(room, pid) {
  return room.whiteId === pid ? 'white' : 'black';
}

function otherPid(room, pid) {
  return room.whiteId === pid ? room.blackId : room.whiteId;
}

function isPlaying(room) {
  return !!room.game && !room.over;
}

function timed(room) {
  return room.settings.minutes > 0;
}

function bind(socket, code, pid) {
  socket.join(code);
  socket.data.room = code;
  socket.data.pid = pid;
}

// 이 소켓의 방과 사람 찾기
function ctx(socket) {
  const room = rooms[socket.data.room];
  const pid = socket.data.pid;
  if (!room || !pid) return null;
  return { room, pid, code: room.code };
}

// ---------- 시계 ----------

// 지금 이 순간의 남은 시간 (밀리초)
function currentClocks(room) {
  if (!timed(room) || !room.clock) return null;
  const c = { w: room.clock.w, b: room.clock.b };
  if (isPlaying(room)) {
    const side = room.game.turn();
    c[side] = Math.max(0, c[side] - (Date.now() - room.lastTick));
  }
  return c;
}

// 지금 차례인 사람의 시간이 다 되는 순간에 맞춰 알람 맞추기
function scheduleTimeout(code) {
  const room = rooms[code];
  if (!room) return;
  clearTimeout(room.timeoutHandle);
  if (!timed(room) || !isPlaying(room)) return;

  const side = room.game.turn();
  const ms = Math.max(0, room.clock[side] - (Date.now() - room.lastTick));
  room.timeoutHandle = setTimeout(() => onTimeout(code, side), ms + 50);
}

function onTimeout(code, side) {
  const room = rooms[code];
  if (!room || !isPlaying(room)) return;

  const remaining = room.clock[side] - (Date.now() - room.lastTick);
  if (remaining > 200) return scheduleTimeout(code); // 아직 남았으면 다시 맞추기

  room.clock[side] = 0;
  endGame(code, 'timeout', side === 'w' ? 'black' : 'white');
}

// ---------- 대기 화면 / 게임 시작 / 게임 끝 ----------

function lobbyInfoFor(room, pid) {
  const oppId = otherPid(room, pid);
  return {
    color: colorOf(room, pid),
    isHost: pid === room.hostId,
    meReady: !!room.ready[pid],
    oppReady: !!room.ready[oppId],
    rematch: room.rounds > 0,
    settings: room.settings,
  };
}

function sendLobby(code) {
  const room = rooms[code];
  if (!room || !room.whiteId || !room.blackId) return;
  [room.whiteId, room.blackId].forEach((pid) => {
    emitTo(room, pid, 'lobby', lobbyInfoFor(room, pid));
  });
}

function startGame(code) {
  const room = rooms[code];
  room.game = new Chess();
  room.over = false;
  room.drawOffer = null;
  room.ready = {};
  room.rounds += 1;
  room.lastResult = null;
  room.viewsLeft = { white: room.settings.views, black: room.settings.views };

  if (timed(room)) {
    const ms = room.settings.minutes * 60 * 1000;
    room.clock = { w: ms, b: ms };
    room.lastTick = Date.now();
    scheduleTimeout(code);
  } else {
    room.clock = null;
  }

  [room.whiteId, room.blackId].forEach((pid) => {
    const color = colorOf(room, pid);
    emitTo(room, pid, 'gameStart', {
      turn: 'w',
      color,
      clocks: currentClocks(room),
      viewsLeft: room.viewsLeft[color],
      settings: room.settings,
    });
  });
  console.log('게임 시작:', code, '(' + room.rounds + '번째 판)');
}

// 게임을 끝내고, 기보 보기용 판 상태(FEN)를 양쪽에 보내는 함수
function endGame(code, reason, winner) {
  const room = rooms[code];
  if (!room || !room.game || room.over) return;

  room.over = true;
  room.drawOffer = null;
  room.ready = {};
  clearTimeout(room.timeoutHandle);

  const moves = room.game.history();
  const replay = new Chess();
  const fens = [replay.fen()];
  moves.forEach((m) => {
    replay.move(m);
    fens.push(replay.fen());
  });

  room.lastResult = {
    reason,
    winner,
    fens,
    history: moves,
    whiteId: room.whiteId,
    blackId: room.blackId,
  };

  [room.whiteId, room.blackId].forEach((pid) => {
    emitTo(room, pid, 'gameOver', {
      reason,
      winner,
      fens,
      history: moves,
      gameColor: colorOf(room, pid),
    });
  });

  // 다시 플레이 / 색 바꾸기 화면 (상대가 나간 경우는 제외)
  if (reason !== 'left') sendLobby(code);
}

function destroyRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearTimeout(room.timeoutHandle);
  Object.values(room.grace).forEach(clearTimeout);
  io.in(code).socketsLeave(code);
  delete rooms[code];
  console.log('방 삭제:', code);
}

// 연결이 끊긴 사람을 일정 시간 기다리고, 안 돌아오면 방을 정리해요
function startGrace(room, pid) {
  clearTimeout(room.grace[pid]);
  const ms = isPlaying(room) ? GRACE_PLAYING_MS : GRACE_IDLE_MS;

  room.grace[pid] = setTimeout(() => {
    const r = rooms[room.code];
    if (!r || r.sockets[pid]) return; // 이미 돌아왔으면 무시

    const oppId = otherPid(r, pid);
    if (isPlaying(r)) {
      endGame(r.code, 'left', null);
    } else if (oppId) {
      emitTo(r, oppId, 'opponentLeft');
    }
    destroyRoom(r.code);
  }, ms);
}

// 새로고침 등으로 돌아온 사람에게 보내줄 "지금 상황" 전체
function buildState(room, pid) {
  const color = colorOf(room, pid);
  const oppId = otherPid(room, pid);

  const state = {
    code: room.code,
    color,
    isHost: pid === room.hostId,
    settings: room.settings,
    hasOpponent: !!oppId,
    opponentConnected: !!(oppId && room.sockets[oppId]),
  };

  if (!oppId) {
    state.phase = 'waiting';
  } else if (isPlaying(room)) {
    state.phase = 'playing';
    state.history = room.game.history();
    state.turn = room.game.turn();
    state.check = room.game.inCheck();
    state.clocks = currentClocks(room);
    state.viewsLeft = room.viewsLeft[color];
    state.draw = !room.drawOffer ? 'none' : (room.drawOffer === color ? 'sent' : 'received');
  } else if (room.over && room.lastResult) {
    const r = room.lastResult;
    state.phase = 'over';
    state.result = {
      reason: r.reason,
      winner: r.winner,
      fens: r.fens,
      history: r.history,
      gameColor: r.whiteId === pid ? 'white' : 'black',
    };
    state.lobby = lobbyInfoFor(room, pid);
  } else {
    state.phase = 'lobby';
    state.lobby = lobbyInfoFor(room, pid);
  }
  return state;
}

// ---------- 소켓 이벤트 ----------

io.on('connection', (socket) => {
  console.log('접속:', socket.id);

  // 방 만들기 (방장이 설정도 함께 보내요)
  socket.on('createRoom', (payload) => {
    const pid = cleanPid(payload && payload.playerId);
    if (!pid) return;

    const code = makeCode();
    const settings = cleanSettings(payload.settings);
    rooms[code] = {
      code,
      hostId: pid,
      whiteId: pid,
      blackId: null,
      sockets: { [pid]: socket.id },
      grace: {},
      settings,
      game: null,
      over: false,
      drawOffer: null,
      ready: {},
      rounds: 0,
      clock: null,
      lastTick: 0,
      timeoutHandle: null,
      viewsLeft: { white: 0, black: 0 },
      lastResult: null,
    };
    bind(socket, code, pid);
    socket.emit('roomCreated', { code, color: 'white', settings });
    console.log('방 생성:', code, settings);
  });

  // 방 들어가기
  socket.on('joinRoom', (payload) => {
    const pid = cleanPid(payload && payload.playerId);
    const code = String((payload && payload.code) || '').trim().toUpperCase();
    const room = rooms[code];
    if (!pid) return;

    if (!room) {
      return socket.emit('errorMsg', '없는 방이에요. 코드를 다시 확인해주세요.');
    }
    if (room.blackId) {
      return socket.emit('errorMsg', '이미 2명이 찬 방이에요.');
    }

    room.blackId = pid;
    room.sockets[pid] = socket.id;
    bind(socket, code, pid);
    socket.emit('roomJoined', { code, color: 'black', settings: room.settings });
    sendLobby(code); // 바로 시작하지 않고 대기 화면으로
    console.log('입장:', code);
  });

  // 새로고침 / 재접속 후 원래 자리로 돌아오기
  socket.on('resume', (payload) => {
    const pid = cleanPid(payload && payload.playerId);
    const code = String((payload && payload.code) || '').trim().toUpperCase();
    const room = rooms[code];

    const known = room && pid && (room.whiteId === pid || room.blackId === pid);
    if (!known) return socket.emit('resumeFailed');

    // 이전 연결이 남아 있으면 정리 (같은 사람이 창을 두 개 연 경우 등)
    const oldSid = room.sockets[pid];
    room.sockets[pid] = socket.id;
    bind(socket, code, pid);
    clearTimeout(room.grace[pid]);
    delete room.grace[pid];

    if (oldSid && oldSid !== socket.id) {
      const old = io.sockets.sockets.get(oldSid);
      if (old) {
        old.data.room = null;
        old.emit('replaced');
        old.disconnect(true);
      }
    }

    socket.emit('resumed', buildState(room, pid));
    emitTo(room, otherPid(room, pid), 'opponentBack');
    console.log('복귀:', code);
  });

  // 방 나가기
  socket.on('leaveRoom', (ack) => {
    const c = ctx(socket);
    if (c) {
      const { room, code, pid } = c;
      const oppId = otherPid(room, pid);
      if (isPlaying(room)) {
        endGame(code, 'left', null);
      } else if (oppId) {
        emitTo(room, oppId, 'opponentLeft');
      }
      destroyRoom(code);
      socket.data.room = null;
    }
    if (typeof ack === 'function') ack();
  });

  // "게임 시작" / "다시 플레이" 버튼
  socket.on('ready', () => {
    const c = ctx(socket);
    if (!c) return;
    const { room, code, pid } = c;
    if (!room.whiteId || !room.blackId) return;
    if (isPlaying(room)) return;

    room.ready[pid] = true;
    if (room.ready[room.whiteId] && room.ready[room.blackId]) {
      startGame(code);
    } else {
      sendLobby(code);
    }
  });

  // 방장이 색 바꾸기
  socket.on('swapColors', () => {
    const c = ctx(socket);
    if (!c) return;
    const { room, code, pid } = c;
    if (pid !== room.hostId) return;
    if (!room.whiteId || !room.blackId) return;
    if (isPlaying(room)) return;

    [room.whiteId, room.blackId] = [room.blackId, room.whiteId];
    room.ready = {};
    sendLobby(code);
  });

  // 수 두기
  socket.on('move', (rawMove) => {
    const c = ctx(socket);
    if (!c || !c.room.game) return;
    const { room, code, pid } = c;

    if (room.over) {
      return socket.emit('illegalMove', '이미 끝난 게임이에요.');
    }

    const me = room.whiteId === pid ? 'w' : 'b';
    if (room.game.turn() !== me) {
      return socket.emit('illegalMove', '지금은 상대방 차례예요.');
    }

    // 시간이 이미 다 됐는지 확인
    const now = Date.now();
    const elapsed = timed(room) ? now - room.lastTick : 0;
    if (timed(room) && room.clock[me] - elapsed <= 0) {
      room.clock[me] = 0;
      return endGame(code, 'timeout', me === 'w' ? 'black' : 'white');
    }

    const text = String(rawMove || '').trim();
    let result;
    try {
      result = room.game.move(text);
    } catch (e) {
      return socket.emit('illegalMove', '"' + text + '"는 둘 수 없는 수예요. 다시 입력해주세요.');
    }

    // 수를 두었으니 내 시계 정리 + 추가 시간
    if (timed(room)) {
      room.clock[me] = room.clock[me] - elapsed + room.settings.increment * 1000;
      room.lastTick = now;
    }

    // 수를 두면 걸려 있던 무승부 제안은 사라져요
    if (room.drawOffer) {
      room.drawOffer = null;
      io.to(code).emit('drawCleared');
    }

    const game = room.game;
    io.to(code).emit('moved', {
      san: result.san,
      by: me === 'w' ? 'white' : 'black',
      history: game.history(),
      turn: game.turn(),
      check: game.inCheck(),
      clocks: currentClocks(room),
    });

    // 게임 끝났는지 확인
    if (game.isGameOver()) {
      if (game.isCheckmate()) {
        endGame(code, 'checkmate', me === 'w' ? 'white' : 'black');
      } else if (game.isStalemate()) {
        endGame(code, 'stalemate', null);
      } else {
        endGame(code, 'draw', null);
      }
    } else {
      scheduleTimeout(code);
    }
  });

  // 체스판 보기 (횟수 제한은 서버가 세요)
  socket.on('viewBoard', () => {
    const c = ctx(socket);
    if (!c || !isPlaying(c.room)) return;
    const { room, pid } = c;

    const color = colorOf(room, pid);
    const left = room.viewsLeft[color];

    if (left === 0) {
      return socket.emit('viewDenied', '체스판을 볼 수 있는 횟수가 남지 않았어요.');
    }
    if (left > 0) room.viewsLeft[color] = left - 1;

    socket.emit('boardView', { fen: room.game.fen(), left: room.viewsLeft[color] });
  });

  // 기권
  socket.on('resign', () => {
    const c = ctx(socket);
    if (!c || !isPlaying(c.room)) return;
    const { room, code, pid } = c;

    const mine = colorOf(room, pid);
    endGame(code, 'resign', mine === 'white' ? 'black' : 'white');
  });

  // 무승부 제안
  socket.on('offerDraw', () => {
    const c = ctx(socket);
    if (!c || !isPlaying(c.room)) return;
    const { room, code, pid } = c;

    const mine = colorOf(room, pid);

    // 상대가 이미 제안한 상태에서 나도 제안하면 합의로 봐요
    if (room.drawOffer && room.drawOffer !== mine) {
      return endGame(code, 'agreement', null);
    }
    if (room.drawOffer === mine) return; // 이미 제안함

    room.drawOffer = mine;
    socket.emit('drawSent');
    emitTo(room, otherPid(room, pid), 'drawOffered');
  });

  // 무승부 수락
  socket.on('acceptDraw', () => {
    const c = ctx(socket);
    if (!c || !isPlaying(c.room)) return;
    const { room, code, pid } = c;

    if (room.drawOffer && room.drawOffer !== colorOf(room, pid)) {
      endGame(code, 'agreement', null);
    }
  });

  // 무승부 거절
  socket.on('declineDraw', () => {
    const c = ctx(socket);
    if (!c || !isPlaying(c.room)) return;
    const { room, pid } = c;

    if (room.drawOffer && room.drawOffer !== colorOf(room, pid)) {
      room.drawOffer = null;
      emitTo(room, otherPid(room, pid), 'drawDeclined');
    }
  });

  // 연결 끊김 (새로고침, 앱 전환, 네트워크 문제 등)
  socket.on('disconnect', () => {
    const c = ctx(socket);
    if (!c) return;
    const { room, pid } = c;

    // 이미 같은 사람의 새 연결로 갈아탔다면 무시
    if (room.sockets[pid] !== socket.id) return;

    room.sockets[pid] = null;
    const oppId = otherPid(room, pid);
    if (oppId) emitTo(room, oppId, 'opponentDisconnected');
    startGrace(room, pid);
    console.log('연결 끊김(대기 중):', room.code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
