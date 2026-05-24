const fs = require("fs");
const { PDFParse } = require("pdf-parse");

(async () => {
    try {
        const caminho = "./teste_convertido.pdf";
        const pdfBuffer = fs.readFileSync(caminho);
        const parser = new PDFParse();
        const data = await parser.parseBuffer(pdfBuffer);
        
        console.log("Paginas:", data.numpages);
        console.log("Texto:", data.text.substring(0, 200));
    } catch (err) {
        console.error("Erro:", err.message);
    }
})();