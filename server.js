const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { v4: uuid } = require('uuid');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static(__dirname));
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

['temp', 'uploads', 'outputs'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

app.post('/api/convert/word-pdf', upload.single('file'), async (req, res) => {
  try {
    console.log('[1] Ficheiro:', req.file.originalname);
    
    const result = await mammoth.convertToHtml({path: req.file.path});
    const html = result.value;
    console.log('[2] HTML extraido');
    
    const texto = html.replace(/<[^>]*>/g, '').trim();
    console.log('[3] Texto:', texto.substring(0, 50) + '...');
    
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    
    const linhas = texto.split('\n');
    let y = 750;
    
    linhas.forEach(linha => {
      if (linha.trim() && y > 50) {
        page.drawText(linha.trim().substring(0, 80), {
          x: 50, y: y, size: 11, font: font, color: rgb(0, 0, 0)
        });
        y -= 15;
      }
    });
    
    console.log('[4] PDF criado');
    
    const nomeOutput = 'convertido_' + uuid() + '.pdf';
    const caminhoOutput = path.join(__dirname, 'outputs', nomeOutput);
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(caminhoOutput, pdfBytes);
    
    console.log('[5] PDF salvo');
    fs.unlinkSync(req.file.path);
    
    res.json({ ok: true, downloadUrl: '/outputs/' + nomeOutput });
    
  } catch (err) {
    console.error('[ERRO]', err.message);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'test-word.html'));
});

app.listen(3000, () => {
  console.log('Servidor: http://localhost:3000');
});
