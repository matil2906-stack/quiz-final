const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

let state = {
  adminCode: 'mathis2906',
  quizCode:  '',
  questions: [],
  phase:     'attente',
  currentQ:  -1,
  players:   {},
  buzzers:   [],        // liste des joueurs qui ont buzzé dans l'ordre
  buzzMax:   1          // nb max de joueurs autorisés à répondre
};

function publicPlayers() {
  return Object.values(state.players).map(p => ({ name: p.name, photo: p.photo || null }));
}

function publicQuestion() {
  const q = state.questions[state.currentQ];
  if (!q) return null;
  return {
    text:    q.text,
    type:    q.type,
    image:   q.image || null,
    youtube: q.youtube || null,
    choices: (q.type === 'qcm' || q.type === 'buzz') ? q.choices.map(c => ({ text: c.text })) : null,
    index:   state.currentQ,
    total:   state.questions.length,
    buzzMax: q.buzzMax || 1
  };
}

function computeResults() {
  const q = state.questions[state.currentQ];
  if (!q) return null;
  const counts = {};
  const playerList = [];
  Object.values(state.players).forEach(p => {
    const ans = p.answers[state.currentQ];
    if (ans == null) return;
    counts[ans] = (counts[ans] || 0) + 1;
    let correct = false;
    if (q.type === 'qcm' || q.type === 'buzz') correct = !!q.choices.find(c => c.text === ans && c.correct);
    if (q.type === 'vf')    correct = ans === q.answer;
    if (q.type === 'libre' && q.answer) correct = ans.toLowerCase() === q.answer.toLowerCase();
    playerList.push({ name: p.name, photo: p.photo || null, answer: ans, correct });
  });
  return { counts, playerList, question: q };
}

function computePodium() {
  return Object.values(state.players).map(p => {
    const score = state.questions.reduce((acc, q, i) => {
      const ans = p.answers[i];
      if (ans == null) return acc;
      if ((q.type === 'qcm' || q.type === 'buzz') && q.choices.find(c => c.text === ans && c.correct)) return acc + 1;
      if (q.type === 'vf' && ans === q.answer) return acc + 1;
      if (q.type === 'libre' && q.answer && ans.toLowerCase() === q.answer.toLowerCase()) return acc + 1;
      return acc;
    }, 0);
    return { name: p.name, photo: p.photo || null, score, total: state.questions.length };
  }).sort((a, b) => b.score - a.score);
}

io.on('connection', socket => {

  socket.on('admin:login', ({ password }, cb) => {
    if (password !== state.adminCode) return cb({ ok: false });
    socket.join('admin');
    cb({ ok: true, quizCode: state.quizCode, adminCode: state.adminCode, questions: state.questions, phase: state.phase, currentQ: state.currentQ, players: publicPlayers() });
  });

  socket.on('admin:saveSettings', ({ adminCode, quizCode }) => {
    if (adminCode) state.adminCode = adminCode;
    if (quizCode !== undefined) state.quizCode = quizCode.toUpperCase();
    socket.emit('admin:settingsOk', { adminCode: state.adminCode, quizCode: state.quizCode });
  });

  socket.on('admin:setQuestions', ({ questions }) => {
    state.questions = questions;
    state.currentQ  = -1;
    state.phase     = 'attente';
    Object.values(state.players).forEach(p => { p.answers = new Array(questions.length).fill(null); });
    io.emit('quiz:state', { phase: 'attente', players: publicPlayers() });
    socket.emit('admin:questionsOk');
  });

  socket.on('admin:start', () => {
    if (!state.questions.length) return;
    state.currentQ = 0;
    state.phase    = 'question';
    state.buzzers  = [];
    Object.values(state.players).forEach(p => { p.answers = new Array(state.questions.length).fill(null); });
    io.emit('quiz:question', { question: publicQuestion(), animate: true });
  });

  socket.on('admin:showResults', () => {
    state.phase = 'resultats';
    io.emit('quiz:results', computeResults());
  });

  socket.on('admin:next', () => {
    if (state.currentQ < state.questions.length - 1) {
      state.currentQ++;
      state.phase   = 'question';
      state.buzzers = [];
      io.emit('quiz:question', { question: publicQuestion(), animate: true });
    } else {
      state.phase = 'fin';
      io.emit('quiz:fin', { podium: computePodium() });
    }
  });

  socket.on('admin:kick', ({ name }) => {
    const entry = Object.entries(state.players).find(([, p]) => p.name === name);
    if (!entry) return;
    const [kickId] = entry;
    io.to(kickId).emit('quiz:kicked');
    delete state.players[kickId];
    io.emit('quiz:playersUpdate', { players: publicPlayers() });
    io.to('admin').emit('admin:playerCount', Object.keys(state.players).length);
  });

  socket.on('admin:reset', () => {
    state.currentQ = -1;
    state.phase    = 'attente';
    state.buzzers  = [];
    Object.values(state.players).forEach(p => { p.answers = []; });
    io.emit('quiz:state', { phase: 'attente', players: publicPlayers() });
  });

  // ── ÉLÈVE ──
  socket.on('eleve:join', ({ code, name, photo }, cb) => {
    if (!state.quizCode) return cb({ ok: false, error: 'Le prof n\'a pas encore défini de code !' });
    if (code.toUpperCase() !== state.quizCode) return cb({ ok: false, error: 'Code incorrect !' });
    state.players[socket.id] = { name, photo: photo || null, answers: new Array(state.questions.length).fill(null) };
    socket.join('players');
    io.emit('quiz:playersUpdate', { players: publicPlayers() });
    io.to('admin').emit('admin:playerCount', Object.keys(state.players).length);
    cb({ ok: true, phase: state.phase, question: state.currentQ >= 0 ? publicQuestion() : null, players: publicPlayers() });
  });

  socket.on('eleve:answer', ({ answer }) => {
    const p = state.players[socket.id];
    if (!p || state.phase !== 'question' || state.currentQ < 0) return;
    const q = state.questions[state.currentQ];
    // Pour le buzz, vérifier si le joueur est autorisé
    if (q.type === 'buzz' && !state.buzzers.includes(socket.id)) return;
    p.answers[state.currentQ] = answer;
    const total    = Object.keys(state.players).length;
    const answered = Object.values(state.players).filter(pl => pl.answers[state.currentQ] != null).length;
    io.to('admin').emit('admin:answerCount', { answered, total });
  });

  // BUZZ
  socket.on('eleve:buzz', () => {
    const p = state.players[socket.id];
    if (!p || state.phase !== 'question' || state.currentQ < 0) return;
    const q = state.questions[state.currentQ];
    if (q.type !== 'buzz') return;
    if (state.buzzers.includes(socket.id)) return;
    const maxBuzzers = q.buzzMax || 1;
    if (state.buzzers.length >= maxBuzzers) {
      socket.emit('quiz:buzzResult', { rank: null, maxBuzzers, allowed: false });
      return;
    }
    state.buzzers.push(socket.id);
    const rank = state.buzzers.length;
    socket.emit('quiz:buzzResult', { rank, maxBuzzers, allowed: true });
    io.to('admin').emit('admin:buzzed', { name: p.name, rank, total: maxBuzzers });
    // Si le max est atteint, bloquer les autres
    if (state.buzzers.length >= maxBuzzers) {
      Object.keys(state.players).forEach(id => {
        if (!state.buzzers.includes(id)) io.to(id).emit('quiz:buzzLocked');
      });
    }
  });

  socket.on('disconnect', () => {
    if (state.players[socket.id]) {
      state.buzzers = state.buzzers.filter(id => id !== socket.id);
      delete state.players[socket.id];
      io.emit('quiz:playersUpdate', { players: publicPlayers() });
      io.to('admin').emit('admin:playerCount', Object.keys(state.players).length);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ BUZZLY sur http://localhost:${PORT}`));
