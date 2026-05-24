const fs = require("fs");
const pdfParse = require("pdf-parse");

(async () => {
    try {
        const caminho = "./teste_convertido.pdf";
        const pdfBuffer = fs.readFileSync(caminho);
        const data = await pdfParse(pdfBuffer);
        
        console.log("Paginas:", data.numpages);
        console.log("Texto:");
        console.log(data.text);
    } catch (err) {
        console.error("Erro:", err.message);
    }
})();
