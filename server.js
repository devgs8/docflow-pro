const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { Document, Packer, Paragraph, HeadingLevel } = require('docx');
const mammoth = require('mammoth');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const winston = require('winston');
const { v4: uuid } = require('uuid');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.simple(),
    transports: [new winston.transports.Console()]
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

app.use((req, res, next) => {
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Frame-Options');
    next();
});

const dirs = ['uploads', 'outputs', 'data', 'logs', 'temp'];
dirs.forEach(dir => {
    const p = path.join(__dirname, dir);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'uploads');
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'image/jpeg', 'image/png'];
        cb(allowed.includes(file.mimetype) ? null : new Error('Tipo não suportado'));
    }
});

const DB_PATH = path.join(__dirname, 'data', 'users.json');

function lerUsers() {
    if (!fs.existsSync(DB_PATH)) return [];
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return []; }
}

function guardarUsers(users) {
    fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

function hashSenha(senha, salt) {
    if (!salt) salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHmac('sha256', salt).update(senha).digest('hex');
    return { hash, salt };
}

function verificarSenha(senha, hashGuardado, salt) {
    const { hash } = hashSenha(senha, salt);
    return hash === hashGuardado;
}

const sessoes = new Map();

function criarSessao(userId, email) {
    const token = crypto.randomBytes(32).toString('hex');
    sessoes.set(token, { userId, email, criadoEm: Date.now() });
    return token;
}

function verificarSessao(token) {
    if (!token) return null;
    const s = sessoes.get(token);
    if (!s) return null;
    if (Date.now() - s.criadoEm > 24 * 60 * 60 * 1000) {
        sessoes.delete(token);
        return null;
    }
    return s;
}

(function seedAdmin() {
    const users = lerUsers();
    if (!users.find(u => u.role === 'admin')) {
        const { hash, salt } = hashSenha('Admin@2026');
        users.push({
            id: crypto.randomUUID(),
            nome: 'Administrador',
            email: 'admin@docflow.ao',
            hash, salt,
            role: 'admin',
            criadoEm: new Date().toISOString()
        });
        guardarUsers(users);
    }
})();

async function converterWordParaPdf(caminhoOrigem) {
    try {
        const { value: textoWord } = await mammoth.extractRawText({ path: caminhoOrigem });
        const pdfDoc = await PDFDocument.create();
        const fonte = await pdfDoc.embedFont(StandardFonts.Helvetica);
        
        const MARGEM = 50, TAMANHO = 11, LINHA = 16, LARG_UTIL = 595 - MARGEM * 2;
        const linhas = [];
        
        (textoWord || 'Documento vazio.').split('\n').forEach(par => {
            if (!par.trim()) { linhas.push(''); return; }
            let linha = '';
            par.split(' ').forEach(p => {
                const teste = linha ? linha + ' ' + p : p;
                if (fonte.widthOfTextAtSize(teste, TAMANHO) > LARG_UTIL && linha) {
                    linhas.push(linha);
                    linha = p;
                } else {
                    linha = teste;
                }
            });
            if (linha) linhas.push(linha);
        });

        let pagina = pdfDoc.addPage([595, 842]);
        let y = 842 - MARGEM;

        for (const linha of linhas) {
            if (y < MARGEM + LINHA) {
                pagina = pdfDoc.addPage([595, 842]);
                y = 842 - MARGEM;
            }
            if (linha) {
                pagina.drawText(linha, { x: MARGEM, y, size: TAMANHO, font: fonte, color: rgb(0, 0, 0) });
            }
            y -= LINHA;
        }

        const caminhoSaida = path.join(__dirname, 'temp', `${uuid()}.pdf`);
        fs.writeFileSync(caminhoSaida, await pdfDoc.save());

        return { caminhoSaida, tamanho: fs.statSync(caminhoSaida).size, qualidade: 95 };
    } catch (err) {
        throw err;
    }
}

async function converterPdfParaWord(caminhoOrigem) {
    try {
        const pdfBytes = fs.readFileSync(caminhoOrigem);
        const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const nPags = pdfDoc.getPageCount();

        const paragrafos = [
            new Paragraph({ text: 'Documento Convertido de PDF', heading: HeadingLevel.HEADING_1, spacing: { after: 200 } }),
            new Paragraph({ text: `Ficheiro: ${path.basename(caminhoOrigem)}`, spacing: { after: 100 } }),
            new Paragraph({ text: `Páginas: ${nPags}`, spacing: { after: 100 } }),
            new Paragraph({ text: `Data: ${new Date().toLocaleString('pt-PT')}`, spacing: { after: 300 } })
        ];

        const doc = new Document({ sections: [{ children: paragrafos }] });
        const caminhoSaida = path.join(__dirname, 'temp', `${uuid()}.docx`);
        const buffer = await Packer.toBuffer(doc);
        fs.writeFileSync(caminhoSaida, buffer);

        return { caminhoSaida, tamanho: buffer.length, paginas: nPags, qualidade: 85 };
    } catch (err) {
        throw err;
    }
}

async function converterPdfParaExcel(caminhoOrigem) {
    try {
        const pdfBytes = fs.readFileSync(caminhoOrigem);
        const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const nPags = pdfDoc.getPageCount();

        const xml = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Dados"><Table><Row><Cell><Data ss:Type="String">Parâmetro</Data></Cell><Cell><Data ss:Type="String">Valor</Data></Cell></Row><Row><Cell><Data ss:Type="String">Ficheiro</Data></Cell><Cell><Data ss:Type="String">${path.basename(caminhoOrigem)}</Data></Cell></Row><Row><Cell><Data ss:Type="String">Páginas</Data></Cell><Cell><Data ss:Type="Number">${nPags}</Data></Cell></Row><Row><Cell><Data ss:Type="String">Tamanho (KB)</Data></Cell><Cell><Data ss:Type="Number">${(pdfBytes.length/1024).toFixed(1)}</Data></Cell></Row><Row><Cell><Data ss:Type="String">Data</Data></Cell><Cell><Data ss:Type="String">${new Date().toLocaleString('pt-PT')}</Data></Cell></Row></Table></Worksheet></Workbook>`;

        const caminhoSaida = path.join(__dirname, 'temp', `${uuid()}.xls`);
        fs.writeFileSync(caminhoSaida, xml, 'utf8');

        return { caminhoSaida, tamanho: fs.statSync(caminhoSaida).size, qualidade: 80 };
    } catch (err) {
        throw err;
    }
}

app.post('/api/auth/register', (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        if (!nome || !email || !senha) return res.status(400).json({ error: 'Dados incompletos.' });

        const users = lerUsers();
        if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
            return res.status(409).json({ error: 'Email já registado.' });
        }

        const { hash, salt } = hashSenha(senha);
        const novoUser = {
            id: crypto.randomUUID(),
            nome,
            email: email.toLowerCase(),
            hash, salt,
            role: 'user',
            criadoEm: new Date().toISOString()
        };

        users.push(novoUser);
        guardarUsers(users);

        const token = criarSessao(novoUser.id, novoUser.email);
        res.json({ ok: true, token, nome, email, role: 'user' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao registar.' });
    }
});

app.post('/api/auth/login', (req, res) => {
    try {
        const { email, senha } = req.body;
        if (!email || !senha) return res.status(400).json({ error: 'Credenciais obrigatórias.' });

        const users = lerUsers();
        const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

        if (!user || !verificarSenha(senha, user.hash, user.salt)) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }

        const token = criarSessao(user.id, user.email);
        res.json({ ok: true, token, nome: user.nome, email: user.email, role: user.role });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao autenticar.' });
    }
});

app.get('/api/auth/me', (req, res) => {
    const token = req.headers['x-auth-token'];
    const sessao = verificarSessao(token);

    if (!sessao) return res.status(401).json({ autenticado: false });

    const users = lerUsers();
    const user = users.find(u => u.id === sessao.userId);

    res.json({ autenticado: true, nome: user?.nome, email: sessao.email, role: user?.role });
});

app.post('/api/convert/word-pdf', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Ficheiro faltando.' });

        const resultado = await converterWordParaPdf(req.file.path);
        const outputFilename = `${uuid()}_convertido.pdf`;
        const outputPath = path.join(__dirname, 'outputs', outputFilename);

        fs.copyFileSync(resultado.caminhoSaida, outputPath);
        fs.unlinkSync(req.file.path);
        fs.unlinkSync(resultado.caminhoSaida);

        res.json({ ok: true, downloadUrl: `/outputs/${outputFilename}`, tamanho: resultado.tamanho, qualidade: resultado.qualidade });
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro: ' + err.message });
    }
});

app.post('/api/convert/pdf-word', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Ficheiro faltando.' });

        const resultado = await converterPdfParaWord(req.file.path);
        const outputFilename = `${uuid()}_convertido.docx`;
        const outputPath = path.join(__dirname, 'outputs', outputFilename);

        fs.copyFileSync(resultado.caminhoSaida, outputPath);
        fs.unlinkSync(req.file.path);
        fs.unlinkSync(resultado.caminhoSaida);

        res.json({ ok: true, downloadUrl: `/outputs/${outputFilename}`, tamanho: resultado.tamanho });
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro: ' + err.message });
    }
});

app.post('/api/convert/pdf-excel', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Ficheiro faltando.' });

        const resultado = await converterPdfParaExcel(req.file.path);
        const outputFilename = `${uuid()}_convertido.xls`;
        const outputPath = path.join(__dirname, 'outputs', outputFilename);

        fs.copyFileSync(resultado.caminhoSaida, outputPath);
        fs.unlinkSync(req.file.path);
        fs.unlinkSync(resultado.caminhoSaida);

        res.json({ ok: true, downloadUrl: `/outputs/${outputFilename}`, tamanho: resultado.tamanho });
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro: ' + err.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ ok: true, versao: '1.0.0', uptime: process.uptime() });
});

app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

app.listen(PORT, () => {
    console.log('\n╔════════════════════════════════════════════════╗');
    console.log(`║  🚀 DocFlow Pro v1.0 → http://localhost:${PORT}  ║`);
    console.log('╚════════════════════════════════════════════════╝\n');
});

module.exports = app;
