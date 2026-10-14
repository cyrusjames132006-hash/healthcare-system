const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'medicore_secret_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const dbFile = path.join(__dirname, 'healthcare.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');

        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            role TEXT DEFAULT 'user'
        )`, () => {
            const adminUser = 'admin';
            const adminPass = 'admin123';
            db.get("SELECT * FROM users WHERE username = ?", [adminUser], (err, row) => {
                if (!row) {
                    const hashedPassword = bcrypt.hashSync(adminPass, 10);
                    db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [adminUser, hashedPassword, 'admin'], () => {
                        console.log('Default Admin Account Created! User: admin | Pass: admin123');
                    });
                }
            });
        });

        // Table para sa mga itinakdang available dates at limitadong slots
        db.run(`CREATE TABLE IF NOT EXISTS appointment_slots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            availableDate TEXT UNIQUE,
            maxSlots INTEGER
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS appointments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            patientName TEXT,
            doctorSelect TEXT,
            appointmentDate TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS medicines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            medName TEXT,
            category TEXT,
            stock INTEGER
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS medical_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            patientName TEXT,
            diagnosis TEXT,
            treatment TEXT,
            recordDate TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS prescriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            patientName TEXT,
            medName TEXT,
            dosage TEXT,
            instructions TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS health_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            serviceName TEXT,
            description TEXT,
            fee TEXT
        )`);
    }
});

function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized. Please login.' });
}

function isAdmin(req, res, next) {
    if (req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).json({ error: 'Access denied. Admin access required.' });
}

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const hashedPassword = bcrypt.hashSync(password, 10);
    db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, 'user')`, [username, hashedPassword], function(err) {
        if (err) return res.status(400).json({ error: 'Username already exists' });
        res.json({ message: 'Registration successful!' });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        req.session.user = { id: user.id, username: user.username, role: user.role };
        res.json({ message: 'Login successful', user: req.session.user });
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: 'Logged out' });
});

app.get('/api/current-user', (req, res) => {
    if (req.session.user) res.json({ loggedIn: true, user: req.session.user });
    else res.json({ loggedIn: false });
});

app.get('/api/users', isAdmin, (req, res) => {
    db.all("SELECT username FROM users WHERE role != 'admin'", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ users: rows });
    });
});

// --- APPOINTMENT SLOTS API ---
app.get('/api/slots', isAuthenticated, (req, res) => {
    db.all("SELECT * FROM appointment_slots", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ slots: rows });
    });
});

app.post('/api/slots', isAdmin, (req, res) => {
    const { availableDate, maxSlots } = req.body;
    db.run(`INSERT INTO appointment_slots (availableDate, maxSlots) VALUES (?, ?)`, [availableDate, maxSlots], function(err) {
        if (err) return res.status(400).json({ error: 'Mayroon nang schedule para sa petsang ito.' });
        res.json({ message: 'Success', id: this.lastID });
    });
});

app.delete('/api/slots/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM appointment_slots WHERE id = ?`, req.params.id, function(err) {
        res.json({ message: 'Deleted' });
    });
});

// --- APPOINTMENTS API ---
app.get('/api/appointments', isAuthenticated, (req, res) => {
    const user = req.session.user;
    if (user.role === 'admin') {
        db.all("SELECT * FROM appointments", [], (err, rows) => { res.json({ appointments: rows }); });
    } else {
        db.all("SELECT * FROM appointments WHERE username = ?", [user.username], (err, rows) => { res.json({ appointments: rows }); });
    }
});

app.post('/api/appointments', isAuthenticated, (req, res) => {
    const { patientName, doctorSelect, appointmentDate } = req.body;
    const username = req.session.user.role === 'admin' ? patientName.trim() : req.session.user.username;

    // Suriin kung available ang date at may natitirang slots pa
    db.get("SELECT * FROM appointment_slots WHERE availableDate = ?", [appointmentDate], (err, slot) => {
        if (!slot) return res.status(400).json({ error: 'Ang pinili mong petsa ay hindi available para sa appointment.' });

        // Bilangin kung ilan na ang nag-book sa petsang ito
        db.get("SELECT COUNT(*) as count FROM appointments WHERE appointmentDate = ?", [appointmentDate], (err, row) => {
            if (row.count >= slot.maxSlots) {
                return res.status(400).json({ error: 'Paumanhin, puno na (fully booked) ang mga slot sa petsang ito.' });
            }

            db.run(`INSERT INTO appointments (username, patientName, doctorSelect, appointmentDate) VALUES (?, ?, ?, ?)`, [username, patientName, doctorSelect, appointmentDate], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: 'Success', id: this.lastID });
            });
        });
    });
});

app.delete('/api/appointments/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM appointments WHERE id = ?`, req.params.id, function(err) { res.json({ message: 'Deleted' }); });
});

// --- MEDICINES API ---
app.get('/api/medicines', isAuthenticated, (req, res) => {
    db.all("SELECT * FROM medicines", [], (err, rows) => { res.json({ medicines: rows }); });
});
app.post('/api/medicines', isAdmin, (req, res) => {
    const { medName, category, stock } = req.body;
    db.run(`INSERT INTO medicines (medName, category, stock) VALUES (?, ?, ?)`, [medName, category, stock], function(err) {
        res.json({ message: 'Success', id: this.lastID });
    });
});
app.delete('/api/medicines/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM medicines WHERE id = ?`, req.params.id, function(err) { res.json({ message: 'Deleted' }); });
});

// --- MEDICAL RECORDS API ---
app.get('/api/medical-records', isAuthenticated, (req, res) => {
    const user = req.session.user;
    if (user.role === 'admin') {
        db.all("SELECT * FROM medical_records", [], (err, rows) => { res.json({ medicalRecords: rows }); });
    } else {
        db.all("SELECT * FROM medical_records WHERE username = ?", [user.username], (err, rows) => { res.json({ medicalRecords: rows }); });
    }
});

app.post('/api/medical-records', isAdmin, (req, res) => {
    const { username, patientName, diagnosis, treatment, recordDate } = req.body;
    db.run(`INSERT INTO medical_records (username, patientName, diagnosis, treatment, recordDate) VALUES (?, ?, ?, ?, ?)`, [username, patientName, diagnosis, treatment, recordDate], function(err) {
        res.json({ message: 'Success', id: this.lastID });
    });
});

app.delete('/api/medical-records/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM medical_records WHERE id = ?`, req.params.id, function(err) { res.json({ message: 'Deleted' }); });
});

// --- PRESCRIPTIONS API ---
app.get('/api/prescriptions', isAuthenticated, (req, res) => {
    const user = req.session.user;
    if (user.role === 'admin') {
        db.all("SELECT * FROM prescriptions", [], (err, rows) => { res.json({ prescriptions: rows }); });
    } else {
        db.all("SELECT * FROM prescriptions WHERE username = ?", [user.username], (err, rows) => { res.json({ prescriptions: rows }); });
    }
});

app.post('/api/prescriptions', isAdmin, (req, res) => {
    const { username, patientName, medName, dosage, instructions } = req.body;
    db.run(`INSERT INTO prescriptions (username, patientName, medName, dosage, instructions) VALUES (?, ?, ?, ?, ?)`, [username, patientName, medName, dosage, instructions], function(err) {
        res.json({ message: 'Success', id: this.lastID });
    });
});

app.delete('/api/prescriptions/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM prescriptions WHERE id = ?`, req.params.id, function(err) { res.json({ message: 'Deleted' }); });
});

// --- HEALTH SERVICES API ---
app.get('/api/health-services', isAuthenticated, (req, res) => {
    db.all("SELECT * FROM health_services", [], (err, rows) => { res.json({ healthServices: rows }); });
});
app.post('/api/health-services', isAdmin, (req, res) => {
    const { serviceName, description, fee } = req.body;
    db.run(`INSERT INTO health_services (serviceName, description, fee) VALUES (?, ?, ?)`, [serviceName, description, fee], function(err) {
        res.json({ message: 'Success', id: this.lastID });
    });
});
app.delete('/api/health-services/:id', isAdmin, (req, res) => {
    db.run(`DELETE FROM health_services WHERE id = ?`, req.params.id, function(err) { res.json({ message: 'Deleted' }); });
});

app.get('/', (req, res) => {
    if (!req.session.user) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const PORT = 3000;
app.listen(3000, '0.0.0.0', () => {
    console.log('Server running at http://localhost:3000');
});