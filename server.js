const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── ÉTAT ─────────────────────────────────────────────────────
let state = {
  adminCode: 'admin1234',
  quizCode:  'QUIZ2025',
  questions: [],
  phase:     'attente',   // attente | question | resultats | fin
  currentQ:  -1,
  players:   {}           // socketId → { name, photo, answers:[] }
};

// ─── HELPERS ──────────────────────────────────────────────────
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
    choices: q.type === 'qcm' ? q.choices.map(c => ({ text: c.text })) : null,
    index:   state.currentQ,
    total:   state.questions.length
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
    if (q.type === 'qcm')   correct = !!q.choices.find(c => c.text === ans && c.correct);
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
      if (q.type === 'qcm' && q.choices.find(c => c.text === ans && c.correct)) return acc + 1;
      if (q.type === 'vf' && ans === q.answer) return acc + 1;
      if (q.type === 'libre' && q.answer && ans.toLowerCase() === q.answer.toLowerCase()) return acc + 1;
      return acc;
    }, 0);
    return { name: p.name, photo: p.photo || null, score, total: state.questions.length };
  }).sort((a, b) => b.score - a.score);
}

// ─── SOCKETS ──────────────────────────────────────────────────
io.on('connection', socket => {

  // ── ADMIN ────────────────────────────────────────────
  socket.on('admin:login', ({ password }, cb) => {
    if (password !== state.adminCode) return cb({ ok: false });
    socket.join('admin');
    cb({
      ok: true,
      quizCode:    state.quizCode,
      adminCode:   state.adminCode,
      questions:   state.questions,
      phase:       state.phase,
      currentQ:    state.currentQ,
      players:     publicPlayers()
    });
  });

  socket.on('admin:saveSettings', ({ adminCode, quizCode }) => {
    if (adminCode) state.adminCode = adminCode;
    if (quizCode)  state.quizCode  = quizCode.toUpperCase();
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
    Object.values(state.players).forEach(p => { p.answers = new Array(state.questions.length).fill(null); });
    io.emit('quiz:question', { question: publicQuestion(), animate: true });
  });

  socket.on('admin:showResults', () => {
    state.phase = 'resultats';
    const results = computeResults();
    io.emit('quiz:results', results);
  });

  socket.on('admin:next', () => {
    if (state.currentQ < state.questions.length - 1) {
      state.currentQ++;
      state.phase = 'question';
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
    // Notifie l'élève kické
    io.to(kickId).emit('quiz:kicked', { message: 'Tu as été exclu de la partie par le prof.' });
    delete state.players[kickId];
    io.emit('quiz:playersUpdate', { players: publicPlayers() });
    io.to('admin').emit('admin:playerCount', Object.keys(state.players).length);
  });

  socket.on('admin:reset', () => {
    state.currentQ = -1;
    state.phase    = 'attente';
    Object.values(state.players).forEach(p => { p.answers = []; });
    io.emit('quiz:state', { phase: 'attente', players: publicPlayers() });
  });

  // ── ÉLÈVE ────────────────────────────────────────────
  socket.on('eleve:join', ({ code, name, photo }, cb) => {
    if (code.toUpperCase() !== state.quizCode) return cb({ ok: false, error: 'Code incorrect !' });
    state.players[socket.id] = {
      name, photo: photo || null,
      answers: new Array(state.questions.length).fill(null)
    };
    socket.join('players');

    // Notifie tout le monde de la nouvelle liste
    io.emit('quiz:playersUpdate', { players: publicPlayers() });
    io.to('admin').emit('admin:playerCount', Object.keys(state.players).length);

    cb({
      ok: true,
      phase:    state.phase,
      question: state.currentQ >= 0 ? publicQuestion() : null,
      players:  publicPlayers()
    });
  });

  socket.on('eleve:answer', ({ answer }) => {
    const p = state.players[socket.id];
    if (!p || state.phase !== 'question' || state.currentQ < 0) return;
    p.answers[state.currentQ] = answer;

    const total    = Object.keys(state.players).length;
    const answered = Object.values(state.players).filter(pl => pl.answers[state.currentQ] != null).length;
    io.to('admin').emit('admin:answerCount', { answered, total });
  });

  socket.on('disconnect', () => {
    if (state.players[socket.id]) {
      delete state.players[socket.id];
      io.emit('quiz:playersUpdate', { players: publicPlayers() });
      io.to('admin').emit('admin:playerCount', Object.keys(state.players).length);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Serveur sur http://localhost:${PORT}`));
