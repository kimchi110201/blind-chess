const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// 방 목록:
// { 'K7X2QP': { host, white, black, game, over, drawOffer, ready, rounds } }
//  host: 방장의 소켓ID (변하지 않아요)
//  white / black: 지금 백/흑을 맡은 소켓ID (색 바꾸기를 하면 서로 바뀌어요)
//  ready: { 소켓ID: true } 다시 플레이/시작 버튼을 누른 사람
//  rounds: 지금까지 시작한 게임 수
const rooms = {};

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 대기 화면 정보를 각자에게 보내는 함수
function sendLobby(code) {
  const room = rooms[code];
  if (!room || !room.white || !room.black) return;

  [room.white, room.black].forEach((id) => {
    const oppId = id === room.white ? room.black : room.white;
    io.to(id).emit('lobby', {
      color: id === room.white ? 'white' : 'black',
      isHost: id === room.host,
      meReady: !!room.ready[id],
      oppReady: !!room.ready[oppId],
      rematch: room.rounds > 0,
    });
  });
}

// 새 게임 시작
function startGame(code) {
  const room = rooms[code];
  room.game = new Chess();
  room.over = false;
  room.drawOffer = null;
  room.ready = {};
  room.rounds += 1;

  [room.white, room.black].forEach((id) => {
    io.to(id).emit('gameStart', {
      turn: 'w',
      color: id === room.white ? 'white' : 'black',
    });
  });
  console.log('게임 시작:', code, '(' + room.rounds + '번째 판)');
}

// 게임을 끝내고, 기보 보기용 판 상태(FEN)를 양쪽에 보내는 함수
function endGame(code, reason, winner) {
  const room = rooms[code];
  if (!room || !room.game) return;

  room.over = true;
  room.drawOffer = null;
  room.ready = {};

  const moves = room.game.history();
  const replay = new Chess();
  const fens = [replay.fen()];
  moves.forEach((m) => {
    replay.move(m);
    fens.push(replay.fen());
  });

  io.to(code).emit('gameOver', { reason, winner, fens });

  // 다시 플레이 / 색 바꾸기 화면 보여주기 (상대가 나간 경우는 제외)
  if (reason !== 'left') sendLobby(code);
}

io.on('connection', (socket) => {
  console.log('접속:', socket.id);

  // 방 만들기
  socket.on('createRoom', () => {
    const code = makeCode();
    rooms[code] = {
      host: socket.id,
      white: socket.id,
      black: null,
      game: null,
      over: false,
      drawOffer: null,
      ready: {},
      rounds: 0,
    };
    socket.join(code);
    socket.data.room = code;
    socket.emit('roomCreated', { code, color: 'white' });
    console.log('방 생성:', code);
  });

  // 방 들어가기
  socket.on('joinRoom', (rawCode) => {
    const code = String(rawCode || '').trim().toUpperCase();
    const room = rooms[code];

    if (!room) {
      return socket.emit('errorMsg', '없는 방이에요. 코드를 다시 확인해주세요.');
    }
    if (room.black) {
      return socket.emit('errorMsg', '이미 2명이 찬 방이에요.');
    }

    room.black = socket.id;
    socket.join(code);
    socket.data.room = code;
    socket.emit('roomJoined', { code, color: 'black' });
    sendLobby(code); // 바로 시작하지 않고 대기 화면으로
    console.log('입장:', code);
  });

  // "게임 시작" / "다시 플레이" 버튼
  socket.on('ready', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.white || !room.black) return;
    if (room.game && !room.over) return; // 게임 중에는 무시

    room.ready[socket.id] = true;

    if (room.ready[room.white] && room.ready[room.black]) {
      startGame(code);
    } else {
      sendLobby(code);
    }
  });

  // 방장이 색 바꾸기
  socket.on('swapColors', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.white || !room.black) return;
    if (socket.id !== room.host) return;      // 방장만 가능
    if (room.game && !room.over) return;      // 게임 중에는 불가

    [room.white, room.black] = [room.black, room.white];
    room.ready = {}; // 준비 상태 초기화
    sendLobby(code);
  });

  // 수 두기
  socket.on('move', (rawMove) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.game) return;

    if (room.over) {
      return socket.emit('illegalMove', '이미 끝난 게임이에요.');
    }

    const myColor = room.white === socket.id ? 'w' : 'b';
    if (room.game.turn() !== myColor) {
      return socket.emit('illegalMove', '지금은 상대방 차례예요.');
    }

    const text = String(rawMove || '').trim();
    let result;
    try {
      result = room.game.move(text);
    } catch (e) {
      return socket.emit('illegalMove', '"' + text + '"는 둘 수 없는 수예요. 다시 입력해주세요.');
    }

    // 수를 두면 걸려 있던 무승부 제안은 사라져요
    if (room.drawOffer) {
      room.drawOffer = null;
      io.to(code).emit('drawCleared');
    }

    const game = room.game;
    io.to(code).emit('moved', {
      san: result.san,
      by: myColor === 'w' ? 'white' : 'black',
      history: game.history(),
      turn: game.turn(),
      check: game.inCheck(),
    });

    // 게임 끝났는지 확인
    if (game.isGameOver()) {
      if (game.isCheckmate()) {
        endGame(code, 'checkmate', myColor === 'w' ? 'white' : 'black');
      } else if (game.isStalemate()) {
        endGame(code, 'stalemate', null);
      } else {
        endGame(code, 'draw', null);
      }
    }
  });

  // 기권
  socket.on('resign', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.game || room.over) return;

    const myColor = room.white === socket.id ? 'white' : 'black';
    endGame(code, 'resign', myColor === 'white' ? 'black' : 'white');
  });

  // 무승부 제안
  socket.on('offerDraw', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.game || room.over) return;

    const myColor = room.white === socket.id ? 'white' : 'black';

    // 상대가 이미 제안한 상태에서 나도 제안하면 합의로 봐요
    if (room.drawOffer && room.drawOffer !== myColor) {
      return endGame(code, 'agreement', null);
    }
    if (room.drawOffer === myColor) return; // 이미 제안함

    room.drawOffer = myColor;
    socket.emit('drawSent');
    socket.to(code).emit('drawOffered');
  });

  // 무승부 수락
  socket.on('acceptDraw', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.game || room.over) return;

    const myColor = room.white === socket.id ? 'white' : 'black';
    if (room.drawOffer && room.drawOffer !== myColor) {
      endGame(code, 'agreement', null);
    }
  });

  // 무승부 거절
  socket.on('declineDraw', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.game || room.over) return;

    const myColor = room.white === socket.id ? 'white' : 'black';
    if (room.drawOffer && room.drawOffer !== myColor) {
      room.drawOffer = null;
      socket.to(code).emit('drawDeclined');
    }
  });

  // 연결 끊김
  socket.on('disconnect', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!code || !room) return;

    if (room.game && !room.over) {
      // 게임 중에 나갔으면 남은 사람에게 기보를 보여줘요
      endGame(code, 'left', null);
    } else {
      socket.to(code).emit('opponentLeft');
    }
    delete rooms[code];
    console.log('방 삭제:', code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});