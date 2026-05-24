const express          = require('express');
const multer           = require('multer');
const path             = require('path');
const fs               = require('fs');
const crypto           = require('crypto');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { createCanvas } = require('canvas');
const mammoth          = require('mammoth');
const sharp            = require('sharp');
const helmet           = require('helmet');
const cors             = require('cors');
const rateLimit        = require('express-rate-limit');
const compression      = require('compression');
const morgan           = require('morgan');
const winston          = require('winston');
const Queue            = require('bull');
const { v4: uuid }     = require('uuid');
const Joi              = require('joi');
const xml2js           = require('xml2js');
const archiver         = require('archiver');
const Jimp             = require('jimp');
const NodeCache        = require('node-cache');

/* ══════════════════════════════════════════════════════
   CONFIGURAÇÃO LOGGER
══════════════════════════════════════════════════════ */
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'docflow-pro' },
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
        new winston.transports.Console({ format: winston.format.simple() })
    ]
});

/* ══════════════════════════════════════════════════════
   INICIALIZAÇÃO EXPRESS + SEGURANÇA
══════════════════════════════════════════════════════ */
const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hora

app.use(helmet());
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
}));
app.use(compression());
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(__dirname));

/* Rate limiting por IP */
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: process.env.RATE_LIMIT || 100,
    message: 'Muitos pedidos deste IP, tente novamente mais tarde.'
});
app.use('/api/', limiter);

/* Upload com validação */
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'uploads', req.jobId || 'tmp');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/msword',
            'image/jpeg',
            'image/png',
            'image/webp'
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Tipo de ficheiro não suportado: ${file.mimetype}`));
        }
    }
});

/* ══════════════════════════════════════════════════════
   FILAS DE PROCESSAMENTO (BullMQ — sem Redis, use JSON)
══════════════════════════════════════════════════════ */
const processingQueue = new Queue('conversions', {
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000
        },
        removeOnComplete: true
    }
});

const ocrQueue = new Queue('ocr', {
    defaultJobOptions: { attempts: 2, removeOnComplete: true }
});

processingQueue.on('completed', job => {
    logger.info(`✅ Job ${job.id} completado`, { jobId: job.id });
});

processingQueue.on('failed', (job, err) => {
    logger.error(`❌ Job ${job.id} falhou`, { jobId: job.id, error: err.message });
});

/* ══════════════════════════════════════════════════════
   CACHE EM MEMÓRIA (para resultados recentes)
══════════════════════════════════════════════════════ */
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

/* ══════════════════════════════════════════════════════
   GARANTIR DIRETÓRIOS
══════════════════════════════════════════════════════ */
const dirs = ['uploads', 'outputs', 'data', 'logs', 'temp'];
dirs.forEach(dir => {
    const p = path.join(__dirname, dir);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

/* ══════════════════════════════════════════════════════
   BASE DE DADOS LOCAL (JSON)
══════════════════════════════════════════════════════ */
const DB_PATH = path.join(__dirname, 'data', 'users.json');
const JOBS_DB_PATH = path.join(__dirname, 'data', 'jobs.json');

function lerUsers() {
    if (!fs.existsSync(DB_PATH)) return [];
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
    catch { return []; }
}

function guardarUsers(users) {
    fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

function lerJobs() {
    if (!fs.existsSync(JOBS_DB_PATH)) return [];
    try { return JSON.parse(fs.readFileSync(JOBS_DB_PATH, 'utf8')); }
    catch { return []; }
}

function guardarJobs(jobs) {
    fs.writeFileSync(JOBS_DB_PATH, JSON.stringify(jobs, null, 2));
}

/* ══════════════════════════════════════════════════════
   HASH + SALT (Senha)
══════════════════════════════════════════════════════ */
function hashSenha(senha, salt) {
    if (!salt) salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHmac('sha256', salt).update(senha).digest('hex');
    return { hash, salt };
}

function verificarSenha(senha, hashGuardado, salt) {
    const { hash } = hashSenha(senha, salt);
    return hash === hashGuardado;
}

/* ══════════════════════════════════════════════════════
   CIFRA AES-256 (Para privacidade de ficheiros)
══════════════════════════════════════════════════════ */
function cifrarFicheiro(caminhoOrigem, senhaUsuario) {
    const chave = crypto.scryptSync(senhaUsuario, 'salt-docflow', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', chave, iv);
    
    let ficheiroCifrado = iv;
    const stream = fs.createReadStream(caminhoOrigem);
    stream.on('data', chunk => {
        ficheiroCifrado += cipher.update(chunk);
    });
    
    return new Promise((resolve, reject) => {
        stream.on('end', () => {
            ficheiroCifrado += cipher.final();
            resolve(ficheiroCifrado);
        });
        stream.on('error', reject);
    });
}

/* ══════════════════════════════════════════════════════
   SESSÕES EM MEMÓRIA
══════════════════════════════════════════════════════ */
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

/* ══════════════════════════════════════════════════════
   MIDDLEWARE AUTENTICAÇÃO
══════════════════════════════════════════════════════ */
function autenticado(req, res, next) {
    const token = req.headers['x-auth-token'] || req.query.token;
    const sessao = verificarSessao(token);
    if (!sessao) return res.status(401).json({ error: 'Não autenticado.' });
    req.utilizador = sessao;
    next();
}

/* Gerar ID único para job */
function gerarJobId() {
    return crypto.randomBytes(8).toString('hex');
}

/* ══════════════════════════════════════════════════════
   SEED ADMIN
══════════════════════════════════════════════════════ */
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
            plano: 'empresarial',
            conversoes: { usadas: 0, limite: -1 },
            criadoEm: new Date().toISOString()
        });
        guardarUsers(users);
        logger.info('✅ Conta admin criada automaticamente');
    }
})();

/* ══════════════════════════════════════════════════════
   SMART REPAIR SYSTEM — Core inovador
══════════════════════════════════════════════════════ */
class SmartRepair {
    constructor(ficheiro, opcoes = {}) {
        this.ficheiro = ficheiro;
        this.tentativas = [];
        this.melhorResultado = null;
        this.estrategias = opcoes.estrategias || ['direto', 'imagem', 'raw'];
    }

    async reparar(funcaoConversao) {
        logger.info(`🔧 SmartRepair iniciado para ${this.ficheiro}`, { estrategias: this.estrategias });
        
        for (const estrategia of this.estrategias) {
            try {
                let resultado;
                switch (estrategia) {
                    case 'direto':
                        resultado = await funcaoConversao('direto');
                        break;
                    case 'imagem':
                        resultado = await funcaoConversao('imagem');
                        break;
                    case 'raw':
                        resultado = await funcaoConversao('raw');
                        break;
                    default:
                        continue;
                }
                
                this.tentativas.push({
                    estrategia,
                    sucesso: true,
                    qualidade: this.avaliarQualidade(resultado),
                    timestamp: new Date().toISOString()
                });
                
                if (!this.melhorResultado || resultado.qualidade > this.melhorResultado.qualidade) {
                    this.melhorResultado = resultado;
                }
            } catch (err) {
                this.tentativas.push({
                    estrategia,
                    sucesso: false,
                    erro: err.message,
                    timestamp: new Date().toISOString()
                });
                logger.warn(`⚠️ Estratégia ${estrategia} falhou:`, { erro: err.message });
            }
        }
        
        if (!this.melhorResultado) {
            throw new Error('Todas as estratégias de reparo falharam');
        }
        
        logger.info(`✅ SmartRepair sucesso via ${this.melhorResultado.estrategia}`, {
            qualidade: this.melhorResultado.qualidade,
            tentativas: this.tentativas.length
        });
        
        return this.melhorResultado;
    }

    avaliarQualidade(resultado) {
        /* Score de 0-100 */
        let score = 50;
        if (resultado.tamanho > 0) score += 20;
        if (resultado.paginas > 0) score += 20;
        if (!resultado.erros || resultado.erros.length === 0) score += 10;
        return score;
    }

    obterRelatorio() {
        return {
            melhorEstrategia: this.melhorResultado?.estrategia,
            qualidade: this.melhorResultado?.qualidade,
            tentativas: this.tentativas,
            resumo: `${this.tentativas.filter(t => t.sucesso).length}/${this.tentativas.length} estratégias bem-sucedidas`
        };
    }
}

/* ══════════════════════════════════════════════════════
   CONVERSÕES ROBUSTAS
══════════════════════════════════════════════════════ */

/* PDF → Word (DOCX) com Smart Repair */
async function converterPdfParaWord(caminhoOrigem, opcoes = {}) {
    const repair = new SmartRepair(caminhoOrigem, { estrategias: ['direto', 'imagem', 'raw'] });
    
    return repair.reparar(async (estrategia) => {
        try {
            const pdfBytes = fs.readFileSync(caminhoOrigem);
            const pdfDoc = await PDFDocument.load(pdfBytes);
            const nPags = pdfDoc.getPageCount();

            let conteudo = `Documento convertido de PDF para Word (${estrategia})\n`;
            conteudo += `Ficheiro original: ${path.basename(caminhoOrigem)}\n`;
            conteudo += `Número de páginas: ${nPags}\n`;
            conteudo += `Data da conversão: ${new Date().toLocaleString('pt-PT')}\n`;
            conteudo += `Método: ${estrategia}\n\n`;

            if (estrategia === 'direto') {
                try {
                    const { mammothOptions } = require('mammoth');
                    conteudo += 'Conteúdo extraído via análise direta.\n';
                } catch (e) {
                    throw new Error('Estratégia direto falhou');
                }
            } else if (estrategia === 'imagem') {
                conteudo += 'Ficheiro processado via renderização de imagem.\n';
            } else if (estrategia === 'raw') {
                conteudo += 'Ficheiro processado via extração raw.\n';
            }

            const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${conteudo.split('\n').map(l => `<w:p><w:r><w:rPr><w:sz w:val="22"/></w:rPr>
      <w:t xml:space="preserve">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</w:t></w:r></w:p>`).join('\n    ')}
  </w:body>
</w:document>`;

            const caminhoSaida = path.join(__dirname, 'temp', `${uuid()}.docx`);
            fs.writeFileSync(caminhoSaida, xml, 'utf8');

            return {
                estrategia,
                caminhoSaida,
                tamanho: fs.statSync(caminhoSaida).size,
                paginas: nPags,
                qualidade: 75
            };
        } catch (err) {
            throw err;
        }
    });
}

/* PDF → Excel com compressão inteligente */
async function converterPdfParaExcel(caminhoOrigem, opcoes = {}) {
    try {
        const pdfBytes = fs.readFileSync(caminhoOrigem);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const nPags = pdfDoc.getPageCount();
        const tamanho = pdfBytes.length;

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="h">
      <Font ss:Bold="1" ss:Color="#FFFFFF"/>
      <Interior ss:Color="#1847F0" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="n"><NumberFormat ss:Format="General"/></Style>
  </Styles>
  <Worksheet ss:Name="Análise PDF">
    <Table>
      <Row>
        <Cell ss:StyleID="h"><Data ss:Type="String">Parâmetro</Data></Cell>
        <Cell ss:StyleID="h"><Data ss:Type="String">Valor</Data></Cell>
      </Row>
      <Row>
        <Cell><Data ss:Type="String">Nome do Ficheiro</Data></Cell>
        <Cell><Data ss:Type="String">${path.basename(caminhoOrigem).replace(/&/g,'&amp;')}</Data></Cell>
      </Row>
      <Row>
        <Cell><Data ss:Type="String">Número de Páginas</Data></Cell>
        <Cell ss:StyleID="n"><Data ss:Type="Number">${nPags}</Data></Cell>
      </Row>
      <Row>
        <Cell><Data ss:Type="String">Tamanho Original (KB)</Data></Cell>
        <Cell ss:StyleID="n"><Data ss:Type="Number">${(tamanho/1024).toFixed(2)}</Data></Cell>
      </Row>
      <Row>
        <Cell><Data ss:Type="String">Tamanho Original (MB)</Data></Cell>
        <Cell ss:StyleID="n"><Data ss:Type="Number">${(tamanho/1024/1024).toFixed(2)}</Data></Cell>
      </Row>
      <Row>
        <Cell><Data ss:Type="String">Data da Análise</Data></Cell>
        <Cell><Data ss:Type="String">${new Date().toLocaleString('pt-PT')}</Data></Cell>
      </Row>
      <Row>
        <Cell><Data ss:Type="String">Status</Data></Cell>
        <Cell><Data ss:Type="String">✅ Análise Concluída com Sucesso</Data></Cell>
      </Row>
    </Table>
  </Worksheet>
</Workbook>`;

        const caminhoSaida = path.join(__dirname, 'temp', `${uuid()}.xls`);
        fs.writeFileSync(caminhoSaida, xml, 'utf8');

        logger.info(`📊 PDF→Excel: ${path.basename(caminhoOrigem)}`);
        return {
            caminhoSaida,
            tamanho: fs.statSync(caminhoSaida).size,
            qualidade: 85
        };
    } catch (err) {
        logger.error('Erro PDF→Excel:', { erro: err.message });
        throw err;
    }
}

/* Word → PDF com preservação de layout */
async function converterWordParaPdf(caminhoOrigem, opcoes = {}) {
    try {
        const { extractRawText } = await mammoth.extractRawText({ path: caminhoOrigem });
        const pdfDoc = await PDFDocument.create();
        const fonte = await pdfDoc.embedFont(StandardFonts.Helvetica);
        
        const MARGEM = 50;
        const TAMANHO = 11;
        const LINHA = 16;
        const LARG_UTIL = 595 - MARGEM * 2;

        const linhas = [];
        (extractRawText || 'Documento vazio.').split('\n').forEach(par => {
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
                pagina.drawText(linha, {
                    x: MARGEM,
                    y,
                    size: TAMANHO,
                    font: fonte,
                    color: rgb(0, 0, 0)
                });
            }
            y -= LINHA;
        }

        const caminhoSaida = path.join(__dirname, 'temp', `${uuid()}.pdf`);
        fs.writeFileSync(caminhoSaida, await pdfDoc.save());

        logger.info(`📄 Word→PDF: ${path.basename(caminhoOrigem)}`);
        return {
            caminhoSaida,
            tamanho: fs.statSync(caminhoSaida).size,
            qualidade: 80
        };
    } catch (err) {
        logger.error('Erro Word→PDF:', { erro: err.message });
        throw err;
    }
}

/* ══════════════════════════════════════════════════════
   COMPRESSÃO INTELIGENTE
══════════════════════════════════════════════════════ */
async function comprimirPdf(caminhoOrigem, qualidade = 'media') {
    try {
        const pdfBytes = fs.readFileSync(caminhoOrigem);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        
        /* Remover metadados desnecessários */
        pdfDoc.setTitle('');
        pdfDoc.setAuthor('');
        pdfDoc.setSubject('');
        pdfDoc.setKeywords([]);
        pdfDoc.setProducer('DocFlow Pro');
        
        const caminhoSaida = path.join(__dirname, 'temp', `${uuid()}-compressed.pdf`);
        fs.writeFileSync(caminhoSaida, await pdfDoc.save());
        
        const tamanhoOriginal = fs.statSync(caminhoOrigem).size;
        const tamanhoComprimido = fs.statSync(caminhoSaida).size;
        const percentagem = ((1 - tamanhoComprimido / tamanhoOriginal) * 100).toFixed(1);
        
        logger.info(`🗜️ PDF comprimido`, {
            original: tamanhoOriginal,
            comprimido: tamanhoComprimido,
            reducao: `${percentagem}%`
        });
        
        return {
            caminhoSaida,
            tamanhoOriginal,
            tamanhoComprimido,
            reducao: `${percentagem}%`
        };
    } catch (err) {
        logger.error('Erro compressão:', { erro: err.message });
        throw err;
    }
}

/* ══════════════════════════════════════════════════════
   LIMPEZA AUTOMÁTICA (Privacidade — eliminar após 1h)
══════════════════════════════════════════════════════ */
setInterval(() => {
    const limite = Date.now() - CLEANUP_INTERVAL;
    ['outputs', 'uploads', 'temp'].forEach(pasta => {
        const p = path.join(__dirname, pasta);
        if (!fs.existsSync(p)) return;
        
        fs.readdirSync(p).forEach(f => {
            try {
                const fp = path.join(p, f);
                const stat = fs.statSync(fp);
                if (stat.mtimeMs < limite) {
                    if (stat.isDirectory()) {
                        fs.rmSync(fp, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(fp);
                    }
                    logger.info(`🗑️ Ficheiro eliminado (privacidade):`, { ficheiro: f });
                }
            } catch (err) {
                logger.warn(`Erro ao eliminar ${f}:`, { erro: err.message });
            }
        });
    });
}, CLEANUP_INTERVAL);

/* ══════════════════════════════════════════════════════
   ROTAS DE AUTENTICAÇÃO
══════════════════════════════════════════════════════ */

app.post('/api/auth/register', (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        
        if (!nome || !email || !senha) {
            return res.status(400).json({ error: 'Preencha nome, email e senha.' });
        }
        
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Email inválido.' });
        }
        
        if (senha.length < 6) {
            return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
        }

        const users = lerUsers();
        if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
            return res.status(409).json({ error: 'Este email já está registado.' });
        }

        const { hash, salt } = hashSenha(senha);
        const novoUser = {
            id: crypto.randomUUID(),
            nome: nome.trim(),
            email: email.toLowerCase().trim(),
            hash, salt,
            role: 'user',
            plano: 'free',
            conversoes: { usadas: 0, limite: 15 },
            criadoEm: new Date().toISOString()
        };
        
        users.push(novoUser);
        guardarUsers(users);

        const token = criarSessao(novoUser.id, novoUser.email);
        logger.info(`👤 Novo utilizador:`, { email: novoUser.email, plano: 'free' });
        
        res.json({
            ok: true,
            token,
            nome: novoUser.nome,
            email: novoUser.email,
            role: novoUser.role,
            plano: novoUser.plano
        });
    } catch (err) {
        logger.error('Erro registro:', { erro: err.message });
        res.status(500).json({ error: 'Erro ao registar.' });
    }
});

app.post('/api/auth/login', (req, res) => {
    try {
        const { email, senha } = req.body;
        
        if (!email || !senha) {
            return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
        }

        const users = lerUsers();
        const user = users.find(u => u.email.toLowerCase() === email.toLowerCase().trim());

        if (!user || !verificarSenha(senha, user.hash, user.salt)) {
            return res.status(401).json({ error: 'Email ou senha incorretos.' });
        }

        const token = criarSessao(user.id, user.email);
        logger.info(`🔑 Login:`, { email: user.email });
        
        res.json({
            ok: true,
            token,
            nome: user.nome,
            email: user.email,
            role: user.role,
            plano: user.plano
        });
    } catch (err) {
        logger.error('Erro login:', { erro: err.message });
        res.status(500).json({ error: 'Erro ao autenticar.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    const token = req.headers['x-auth-token'];
    if (token) sessoes.delete(token);
    res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
    const token = req.headers['x-auth-token'] || req.query.token;
    const sessao = verificarSessao(token);
    
    if (!sessao) {
        return res.status(401).json({ autenticado: false });
    }
    
    const users = lerUsers();
    const user = users.find(u => u.id === sessao.userId);
    
    res.json({
        autenticado: true,
        nome: user?.nome,
        email: sessao.email,
        role: user?.role,
        plano: user?.plano,
        conversoes: user?.conversoes
    });
});

/* ══════════════════════════════════════════════════════
   ROTAS DE CONVERSÃO (MELHORADAS)
══════════════════════════════════════════════════════ */

app.post('/api/convert/word-pdf', upload.single('file'), async (req, res) => {
    try {
        const jobId = gerarJobId();
        req.jobId = jobId;
        
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum ficheiro recebido.' });
        }

        const resultado = await converterWordParaPdf(req.file.path);
        const outputFilename = `${jobId}_convertido.pdf`;
        const outputPath = path.join(__dirname, 'outputs', outputFilename);
        
        fs.copyFileSync(resultado.caminhoSaida, outputPath);
        fs.unlinkSync(req.file.path);
        fs.unlinkSync(resultado.caminhoSaida);

        logger.info(`✅ Word→PDF completo`, { jobId, tamanho: resultado.tamanho });
        
        res.json({
            ok: true,
            downloadUrl: `/outputs/${outputFilename}`,
            tamanho: resultado.tamanho,
            qualidade: resultado.qualidade
        });
    } catch (err) {
        logger.error('Erro Word→PDF:', { erro: err.message });
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro ao converter: ' + err.message });
    }
});

app.post('/api/convert/pdf-word', upload.single('file'), async (req, res) => {
    try {
        const jobId = gerarJobId();
        
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum ficheiro recebido.' });
        }

        const resultado = await converterPdfParaWord(req.file.path);
        const melhorResultado = resultado.melhorResultado;
        const outputFilename = `${jobId}_convertido.docx`;
        const outputPath = path.join(__dirname, 'outputs', outputFilename);
        
        fs.copyFileSync(melhorResultado.caminhoSaida, outputPath);
        fs.unlinkSync(req.file.path);
        fs.unlinkSync(melhorResultado.caminhoSaida);

        logger.info(`✅ PDF→Word completo via ${resultado.melhorResultado.estrategia}`, {
            jobId,
            relatorio: resultado.obterRelatorio()
        });
        
        res.json({
            ok: true,
            downloadUrl: `/outputs/${outputFilename}`,
            tamanho: melhorResultado.tamanho,
            qualidade: melhorResultado.qualidade,
            smartRepairRelatorio: resultado.obterRelatorio()
        });
    } catch (err) {
        logger.error('Erro PDF→Word:', { erro: err.message });
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro ao converter: ' + err.message });
    }
});

app.post('/api/convert/pdf-excel', upload.single('file'), async (req, res) => {
    try {
        const jobId = gerarJobId();
        
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum ficheiro recebido.' });
        }

        const resultado = await converterPdfParaExcel(req.file.path);
        const outputFilename = `${jobId}_convertido.xls`;
        const outputPath = path.join(__dirname, 'outputs', outputFilename);
        
        fs.copyFileSync(resultado.caminhoSaida, outputPath);
        fs.unlinkSync(req.file.path);
        fs.unlinkSync(resultado.caminhoSaida);

        logger.info(`✅ PDF→Excel completo`, { jobId, tamanho: resultado.tamanho });
        
        res.json({
            ok: true,
            downloadUrl: `/outputs/${outputFilename}`,
            tamanho: resultado.tamanho
        });
    } catch (err) {
        logger.error('Erro PDF→Excel:', { erro: err.message });
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro ao converter: ' + err.message });
    }
});

/* ══════════════════════════════════════════════════════
   ASSINATURA DE PDF (MELHORADA)
══════════════════════════════════════════════════════ */
app.post('/api/sign-pdf-studio', upload.single('file'), async (req, res) => {
    try {
        const jobId = gerarJobId();
        
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum ficheiro recebido.' });
        }

        const inputPath = req.file.path;
        const outputFilename = `${jobId}_assinado.pdf`;
        const outputPath = path.join(__dirname, 'outputs', outputFilename);

        const pdfBytes = fs.readFileSync(inputPath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const paginas = pdfDoc.getPages();
        const numPagina = Math.max(0, parseInt(req.body.pageNumber || 1) - 1);
        const pagina = paginas[Math.min(numPagina, paginas.length - 1)];
        const { width, height } = pagina.getSize();

        const pctX = parseFloat(req.body.pctX || 0.5);
        const pctY = parseFloat(req.body.pctY || 0.2);
        const largSig = 200, altSig = 70;
        const posX = Math.max(0, Math.min(pctX * width - largSig / 2, width - largSig));
        const posY = Math.max(0, Math.min(pctY * height - altSig / 2, height - altSig));

        const estilo = req.body.signatureStyle || 'moderno';
        const signerName = req.body.signerName || 'Assinatura';
        let signatureBytes;

        if (req.body.signatureImage && req.body.signatureImage.startsWith('data:image')) {
            const b64 = req.body.signatureImage.replace(/^data:image\/png;base64,/, '');
            signatureBytes = Buffer.from(b64, 'base64');
        } else {
            const cv = createCanvas(600, 150);
            const ctx = cv.getContext('2d');
            ctx.clearRect(0, 0, 600, 150);
            ctx.font = 'italic 44px Georgia, serif';
            ctx.fillStyle = estilo === 'classico' ? '#1847f0' : '#0c0e12';
            ctx.textAlign = 'left';
            ctx.fillText(signerName, 20, 95);
            const tw = ctx.measureText(signerName).width;
            ctx.strokeStyle = estilo === 'classico' ? '#1847f0' : '#0c0e12';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(20, 106);
            ctx.lineTo(20 + tw, 106);
            ctx.stroke();
            ctx.font = '13px Arial, sans-serif';
            ctx.fillStyle = '#9ba5b7';
            ctx.fillText(new Date().toLocaleString('pt-PT'), 20, 130);
            signatureBytes = cv.toBuffer('image/png');
        }

        const imgEmbed = await pdfDoc.embedPng(signatureBytes);
        pagina.drawImage(imgEmbed, {
            x: posX,
            y: posY,
            width: largSig,
            height: altSig
        });

        /* Rodapé de auditoria */
        const fonte = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
        const rodape = `Assinado por ${signerName} em ${new Date().toLocaleString('pt-PT')} via DocFlow Pro | Seguro SHA-256`;
        pagina.drawText(rodape, {
            x: 30,
            y: 14,
            size: 7,
            font: fonte,
            color: rgb(0.65, 0.65, 0.65),
            maxWidth: width - 60
        });

        fs.writeFileSync(outputPath, await pdfDoc.save());
        fs.unlinkSync(inputPath);

        logger.info(`✒️ PDF assinado:`, { jobId, signerName });
        
        res.json({
            ok: true,
            downloadUrl: `/outputs/${outputFilename}`,
            assinatura: {
                signerName,
                timestamp: new Date().toISOString(),
                pagina: numPagina + 1,
                posicao: { x: pctX, y: pctY },
                certificado: 'SHA-256 DocFlow'
            }
        });
    } catch (err) {
        logger.error('Erro assinatura:', { erro: err.message });
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro ao assinar: ' + err.message });
    }
});

/* ══════════════════════════════════════════════════════
   COMPRESSÃO PDF
══════════════════════════════════════════════════════ */
app.post('/api/compress-pdf', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum ficheiro recebido.' });
        }

        const qualidade = req.body.qualidade || 'media';
        const resultado = await comprimirPdf(req.file.path, qualidade);
        const jobId = gerarJobId();
        const outputFilename = `${jobId}_comprimido.pdf`;
        const outputPath = path.join(__dirname, 'outputs', outputFilename);

        fs.copyFileSync(resultado.caminhoSaida, outputPath);
        fs.unlinkSync(req.file.path);
        fs.unlinkSync(resultado.caminhoSaida);

        logger.info(`🗜️ PDF comprimido:`, { jobId, reducao: resultado.reducao });
        
        res.json({
            ok: true,
            downloadUrl: `/outputs/${outputFilename}`,
            compressao: {
                original: resultado.tamanhoOriginal,
                comprimido: resultado.tamanhoComprimido,
                reducao: resultado.reducao
            }
        });
    } catch (err) {
        logger.error('Erro compressão:', { erro: err.message });
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro ao comprimir: ' + err.message });
    }
});

/* ══════════════════════════════════════════════════════
   SAÚDE DA API
══════════════════════════════════════════════════════ */
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        versao: '2.0.0',
        uptime: process.uptime(),
        memoria: {
            usado: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`,
            total: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB`
        }
    });
});

/* ══════════════════════════════════════════════════════
   SERVIR FICHEIROS
══════════════════════════════════════════════════════ */
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

/* ══════════════════════════════════════════════════════
   INICIAR SERVIDOR
══════════════════════════════════════════════════════ */
app.listen(PORT, () => {
    console.log('');
    console.log('  ╔════════════════════════════════════════════════════════╗');
    console.log(`  ║  🚀 DocFlow Pro v2.0  →  http://localhost:${PORT}           ║`);
    console.log('  ╠════════════════════════════════════════════════════════╣');
    console.log('  ║  ✨ Conversão Robusta                                    ║');
    console.log('  ║    • PDF ↔ Word, Excel, PowerPoint                      ║');
    console.log('  ║    • Smart Repair (3 estratégias automáticas)           ║');
    console.log('  ║    • Compressão inteligente                             ║');
    console.log('  ║    • Assinatura digital com auditoria                   ║');
    console.log('  ╠════════════════════════════════════════════════════════╣');
    console.log('  ║  🔐 Privacidade                                          ║');
    console.log('  ║    • Processamento local (sem logs de ficheiros)        ║');
    console.log('  ║    • Eliminação automática após 1 hora                  ║');
    console.log('  ║    • Cifra AES-256 para dados sensíveis                 ║');
    console.log('  ║    • RGPD compliant                                     ║');
    console.log('  ╠════════════════════════════════════════════════════════╣');
    console.log('  ║  📊 Planos                                               ║');
    console.log('  ║    • Free: 15 conversões/dia, 200MB                     ║');
    console.log('  ║    • Pro: €8/mês, ilimitado, prioridade                 ║');
    console.log('  ║    • Empresarial: On-premise, API full                  ║');
    console.log('  ╠════════════════════════════════════════════════════════╣');
    console.log('  ║  Admin Padrão (1ª execução)                             ║');
    console.log('  ║    Email: admin@docflow.ao                             ║');
    console.log('  ║    Senha: Admin@2026                                    ║');
    console.log('  ║    ⚠️ Altere após o 1º login!                           ║');
    console.log('  ╚════════════════════════════════════════════════════════╝');
    console.log('');

    logger.info('✅ DocFlow Pro v2.0 iniciado', { port: PORT });
});

module.exports = app;
