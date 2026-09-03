// Dentro del <script> en tu inventory.html o en tu archivo JS vinculado
document.addEventListener("DOMContentLoaded", async () => {
    try {
        // Hacemos la petición a la ruta que creamos en Express
        const response = await fetch('/api/lentes');
        const datos = await response.json();
        
        console.log("Datos cargados del JSON:", datos);
        console.log("Catálogo:", datos.catalog);
        
        // Aquí ya puedes usar los datos para pintar tablas, listas, etc. en tu HTML
    } catch (error) {
        console.error("Error obteniendo los datos:", error);
    }
});