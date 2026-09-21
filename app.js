const express = require('express'); // Para gestionar la api
const session = require('express-session'); // Para gestionar las cuentas y sesiones
const bcrypt = require('bcrypt'); // Para encriptar las contraseñas
const crypto = require('crypto'); // Para generar los id's aleatorios
const fs = require('fs'); // Añadido para generar los archivos
const { readFile, writeFile } = fs.promises;
const path = require('path'); // Añadido para manejar rutas de forma segura
const console = require('console');

const app = express();
const port = 47100;

// -------------------------------------------------------------
// INICIALIZACIÓN DE ARCHIVOS
// -------------------------------------------------------------
const usersFile = path.join(__dirname, 'users.json');
const lentesFile = path.join(__dirname, 'lentes.json');

function inicializarArchivos() {
  // 1. Generar users.json si no existe
  if (!fs.existsSync(usersFile)) {
    const usersEstructuraBase = [{ id: 1, username: 'admin', password: bcrypt.hashSync('1234', 10) }]
    fs.writeFileSync(usersFile, JSON.stringify(usersEstructuraBase, null, 2), 'utf8');
    console.log('Archivo users.json creado con éxito.');
  }

  // 2. Generar lentes.json si no existe
  if (!fs.existsSync(lentesFile)) {
    const lentesEstructuraBase = {
      catalog: [],
      movimientos: []
    };
    fs.writeFileSync(lentesFile, JSON.stringify(lentesEstructuraBase, null, 2), 'utf8');
    console.log('Archivo lentes.json creado con la estructura base.');
  }
}

// -------------------------------------------------------------
// FUNCIONES DE APOYO
// -------------------------------------------------------------
async function leerJson(ruta) {
  try {
    const data = await readFile(ruta, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error("Error al leer el archivo " + ruta + ": " + error);
  }
}

async function jsonFiltrado(ruta, userID = undefined) {
  const json = await leerJson(ruta);  // ✅ Añadir await
  if (userID) { 
    const data = [];
    for (const element of json) {  // ✅ Cambiar for await por for
      if (element.userID == userID) data.push(element);
    }
    return data;
  } else {
    return await leerJson(ruta);  // ✅ Añadir await
  }
}

// -------------------------------------------------------------
// MIDDLEWARES
// -------------------------------------------------------------

// Procesamiento de datos de formularios
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuración de sesiones
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: false, 
  cookie: { secure: false } 
}));

// MIDDLEWARE DE AUTENTICACIÓN
app.use((req, res, next) => {
  // 1. Agregamos las rutas de tu CSS y JS para que puedan cargar sin sesión
  const rutasPermitidas = [
    '/login', 
    '/signup',
    '/login.html', 
    '/styles/login.css', 
    '/scripts/login.js'
  ];

  // 2. Si la ruta actual está en la lista de permitidas, la dejamos pasar
  if (rutasPermitidas.includes(req.path)) {
    return next();
  }

  // 3. Si el usuario NO tiene sesión, lo enviamos al login
  if (!req.session.userId) {
    return res.redirect('/login');
  }

  // 4. Si el usuario SÍ tiene sesión, continuamos con la petición normal
  next();
});

// Archivos estáticos (protegidos por el middleware de arriba)
app.use(express.static('public'));

// -------------------------------------------------------------
// RUTAS DE AUTENTICACIÓN
// -------------------------------------------------------------

// Ruta del formulario de Login
app.get('/login', (req, res) => {
  return res.redirect('/login.html');
});

// Manejo del Login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const users = await leerJson(usersFile);

  const user = users.find(u => u.username === username);

  // 2. Verificamos que el usuario exista
  if (user) {
    const isPasswordValid = bcrypt.compareSync(password, user.password);

    if (isPasswordValid) {
      req.session.userId = user.id;
      return res.redirect('/index.html');
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

// Manejo del signup
app.post('/signup', async (req, res) => {
  console.log("si nos registramos");
  try {
    const { username, password } = req.body;
    const users = await leerJson(usersFile);

    // Evitar usernames duplicados
    const existingUser = users.find(u => u.username === username);
    if (existingUser) {
      return res.send('El usuario ya existe. Por favor elige otro nombre.');
    }

    const user = {
      id: crypto.randomUUID(),
      username: username,
      password: bcrypt.hashSync(password, 10)
    };
    users.push(user);

    await writeFile(usersFile, JSON.stringify(users, null, 2));

    // Logueamos automáticamente al usuario recién creado
    req.session.userId = user.id;
    return res.redirect('/index.html');

  } catch (error) {
    console.error(error);
    return res.status(500).send('Error al registrar. Intenta de nuevo.');
  }
});

// -------------------------------------------------------------
// MANEJO DE PÁGINAS
// -------------------------------------------------------------
app.get('/inventory', (req, res) => {
  return res.redirect('/inventory.html');
});

app.get('/buy', (req, res) => {
  return res.redirect('/buy.html');
});

app.get('/sell', (req, res) => {
  return res.redirect('/sell.html');
});

app.get('/register', (req, res) => {
  return res.redirect('/register.html');
});

app.get('/finance', (req, res) => {
  return res.redirect('/finance.html');
});

// -------------------------------------------------------------
// MANEJO DE APIS
// -------------------------------------------------------------
// Ruta para obtener todos los lentes
app.get('/api/lentes', async (req, res) => {
  try {
    const datosLentes = await leerJson(lentesFile);
    return res.json(datosLentes); 
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al procesar el inventario' });
  }
});

// Ruta para obtener un lente específico por ID
app.get('/api/lentes/:id', async (req, res) => {
  try {
    const datosLentes = await leerJson(lentesFile);
    const { id } = req.params;

    const inventario = datosLentes.catalog || datosLentes;
    const lenteEncontrado = inventario.find(lente => lente.id === id);

    if (!lenteEncontrado) {
      return res.status(404).json({ error: 'Lente no encontrado' });
    }

    return res.json(lenteEncontrado);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al procesar el inventario' });
  }
});

app.post('/api/lentes', async (req, res) => {
  try {
    const { nArmazon, marca, sucursal, varilla, precioC, precioV } = req.body;
    const idLentes = crypto.randomUUID();
    const createdAt = Date.now();
    const lentesJson = await leerJson(lentesFile);

    const lentes = {
      id: idLentes,
      nombre: nArmazon,
      marca,
      sucursal,
      precioComprado: precioC,
      precioPublico: precioV,
      varilla,
      createdAt,
      stock: 0
    }
    lentesJson.catalog.push(lentes);
    await writeFile(lentesFile, JSON.stringify(lentesJson, null, 2));

    res.status(201).json({ 
      mensaje: 'Lente agregado correctamente', 
      lente: lentes
    });

  } catch (error) {
    console.error("No se ha podido guardar el armazon en el json" + error);
    res.status(500).json({ error: 'Hubo un problema al guardar el lente' });
  }
});

app.put('/api/lentes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nArmazon, marca, sucursal, varilla, precioC, precioV, stock } = req.body;

    const lentesJson = await leerJson(lentesFile);

    // Buscamos el índice del lente en el catálogo
    const index = lentesJson.catalog.findIndex(lente => lente.id === id);

    if (index === -1) {
      return res.status(404).json({ error: 'Lente no encontrado para actualizar' });
    }

    // Actualizamos solo los campos que vengan en el body, manteniendo los existentes
    lentesJson.catalog[index] = {
      ...lentesJson.catalog[index],
      ...(nArmazon !== undefined && { nombre: nArmazon }),
      ...(marca !== undefined && { marca }),
      ...(sucursal !== undefined && { sucursal }),
      ...(varilla !== undefined && { varilla }),
      ...(precioC !== undefined && { precioComprado: precioC }),
      ...(precioV !== undefined && { precioPublico: precioV }),
      ...(stock !== undefined && { stock })
    };

    // Guardamos los cambios en el archivo JSON
    await writeFile(lentesFile, JSON.stringify(lentesJson, null, 2));

    res.json({
      mensaje: 'Lente actualizado correctamente',
      lente: lentesJson.catalog[index]
    });

  } catch (error) {
    console.error("Error al actualizar el lente: " + error);
    res.status(500).json({ error: 'Hubo un problema al actualizar el lente' });
  }
});

app.post('/api/compras', async (req, res) => {
  try {
    const { id, cantidad, precioUnitario } = req.body;

    if (req.body === 0) {
      return res.status(400).json({ error: 'La lista de compras está vacía' });
    }

    const idMov = crypto.randomUUID();
    const lentesJson = await leerJson(lentesFile);
    const fechaHoy = new Date().toISOString().split('T')[0];

    const movimiento = {
      "id": idMov,
      "frameId": id,
      "tipo": "compra",
      "cantidad": cantidad,
      "precioUnitario": precioUnitario,
      "fecha": fechaHoy,
      "createdAt": Date.now()
    }

    const index = lentesJson.catalog.findIndex(lente => lente.id === id);
    lentesJson.catalog[index].stock += cantidad; //Quitamos los lentes que acabamos de comprar del stock

    lentesJson.movimientos.push(movimiento);

    await writeFile(lentesFile, JSON.stringify(lentesJson, null, 2));

    res.status(201).json({
      mensaje: 'Compra registrada exitosamente'
    });
  } catch (error) {
    console.error(`Error al generar una compra ${error}`);
  }
});

app.post('/api/ventas', async (req, res) => {
  try {
    const { id, cantidad, precioUnitario } = req.body;

    if (req.body === 0) {
      return res.status(400).json({ error: 'La lista de compras está vacía' });
    }

    const idMov = crypto.randomUUID();
    const lentesJson = await leerJson(lentesFile);
    const fechaHoy = new Date().toISOString().split('T')[0];

    const movimiento = {
      "id": idMov,
      "frameId": id,
      "tipo": "venta",
      "cantidad": cantidad,
      "precioUnitario": precioUnitario,
      "fecha": fechaHoy,
      "createdAt": Date.now()
    }

    const index = lentesJson.catalog.findIndex(lente => lente.id === id);
    lentesJson.catalog[index].stock -= cantidad; //Quitamos los lentes que acabamos de comprar del stock

    lentesJson.movimientos.push(movimiento);

    await writeFile(lentesFile, JSON.stringify(lentesJson, null, 2));

    res.status(201).json({
      mensaje: 'Compra registrada exitosamente'
    });
  } catch (error) {
    console.error(`Error al generar una venta ${error}`);
  }
});

// Ruta por defecto 404
app.use((req, res) => {
  res.status(404).send('Perdón, no existe este enlace :(');
});

// -------------------------------------------------------------
// INICIO DEL SERVIDOR
// -------------------------------------------------------------
// Ejecutamos la validación de archivos antes de abrir el puerto
inicializarArchivos();

app.listen(port, () => {
  console.log(`Servidor ejecutándose en: http://localhost:${port}`);
});