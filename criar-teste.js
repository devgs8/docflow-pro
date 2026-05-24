const { Document, Packer, Paragraph } = require('docx');
const fs = require('fs');

const doc = new Document({
  sections: [{
    children: [
      new Paragraph({
        text: "DOCUMENTO DE TESTE",
        heading: true,
        spacing: { after: 200 }
      }),
      new Paragraph({
        text: "Este é um documento de teste para DocFlow Pro.",
        spacing: { after: 100 }
      }),
      new Paragraph({
        text: "Conteúdo: Testando conversão de Word para PDF."
      })
    ]
  }]
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync('teste.docx', buffer);
  console.log('✅ teste.docx criado!');
});
