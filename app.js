const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
const port = 47100;

// Middleware (procesamiento de datos de formularios)
app.use(express.urlencoded({ extended: true }));

// Configuración de sesiones
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: false, // Recomendado cambiar a false para seguridad/rendimiento
  cookie: { secure: false } // Cambiar a true si usas HTTPS en producción
}));

// Archivos estáticos
app.use(express.static('public'));

// Base de datos en memoria (bcrypt hash para la contraseña 'password')
const users = [
  { id: 1, username: 'admin', password: bcrypt.hashSync('1234', 10) }
];

// Ruta del formulario de Login
app.get('/login', (req, res) => {
  return res.redirect('login.html');
});

// Manejo del Login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);

  if (user) {
    const isPasswordValid = bcrypt.compareSync(password, user.password);

    if (isPasswordValid) {
      req.session.userId = user.id;
      return res.redirect('index.html');
    }
  }

  res.send('Invalid credentials. Please try again.');
});

// Manejo del Logout
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send('Error logging out. Please try again.');
    }
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

// Ruta por defecto 404
app.use((req, res) => {
  res.status(404).send('Perdón, no existe este enlace :(');
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor ejecutándose en: http://localhost:${port}`);
});