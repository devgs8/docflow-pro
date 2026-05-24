const fs = require("fs");
const pdfjsLib = require("pdfjs-dist");

(async () => {
    try {
        const caminho = "./teste_convertido.pdf";
        const buffer = fs.readFileSync(caminho);
        const data = new Uint8Array(buffer);
        const pdf = await pdfjsLib.getDocument(data).promise;
        
        console.log("Total de paginas:", pdf.numPages);
        
        let textoTotal = "";
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(" ");
            textoTotal += pageText + "\n";
        }
        
        console.log("Texto extraido:");
        console.log(textoTotal);
    } catch (err) {
        console.error("Erro:", err.message);
    }
})();