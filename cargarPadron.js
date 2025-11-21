const fs = require("fs");
const path = require("path");
const readline = require("readline");
const admin = require("firebase-admin");

// --- CONFIGURACIÓN ---
const SERVICE_ACCOUNT = "";
const BUCKET_NAME = "";
const LOCAL_FOLDER = "./fotos";
const STORAGE_DESTINATION_FOLDER = "votantes_fotos";
const LISTA_STORAGE_TXT = "./src/data/lista_storage.txt";

// Archivos de control generados
const FILE_PROGRESO_JSON = "./progreso.json";
const FILE_LISTA_READABLE = "./faltantes_lista.txt";

const CONCURRENCY_LIMIT = 15; // Archivos simultáneos

// --- INICIALIZACIÓN FIREBASE ---
if (!fs.existsSync(SERVICE_ACCOUNT)) {
  console.error("❌ Error: Falta el archivo de credenciales JSON.");
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(require(SERVICE_ACCOUNT)),
  storageBucket: BUCKET_NAME,
});
const bucket = admin.storage().bucket();

// --- UTILIDADES DE CONSOLA ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

// --- LOGICA DE NEGOCIO ---

// 1. Función para escanear y generar la cola inicial (Solo se ejecuta si no hay progreso guardado)
function generarColaDeTrabajo() {
  console.log("📊 Generando nueva lista de faltantes...");

  // A. Cargar lista de Storage (con el fix de UTF-16)
  const buffer = fs.readFileSync(LISTA_STORAGE_TXT);
  let content =
    buffer.indexOf(0) !== -1
      ? buffer.toString("utf16le")
      : buffer.toString("utf8");

  const existingSet = new Set();
  content.split(/\r?\n/).forEach((line) => {
    let clean = line.trim().replace(/\u0000/g, "");
    if (clean && !clean.endsWith(":") && !clean.endsWith("/")) {
      // Validar que sea imagen para evitar basura
      if (path.basename(clean).match(/\.(jpg|jpeg|png)$/i)) {
        existingSet.add(path.basename(clean));
      }
    }
  });

  // B. Leer carpeta local
  const localFiles = fs
    .readdirSync(LOCAL_FOLDER)
    .filter((f) => f.match(/\.(jpg|jpeg|png)$/i));

  // C. Calcular faltantes
  const faltantes = localFiles.filter((f) => !existingSet.has(f));

  if (faltantes.length === 0) {
    console.log("🎉 ¡Todo sincronizado! No falta nada.");
    process.exit(0);
  }

  // D. Guardar archivos de control
  // 1. JSON para el script
  fs.writeFileSync(FILE_PROGRESO_JSON, JSON.stringify(faltantes, null, 2));

  // 2. TXT para el humano (uno por línea)
  fs.writeFileSync(FILE_LISTA_READABLE, faltantes.join("\n"));

  console.log(`✅ Se detectaron ${faltantes.length} archivos faltantes.`);
  console.log(`📄 Lista visible guardada en: ${FILE_LISTA_READABLE}`);
  console.log(`💾 Estado guardado en: ${FILE_PROGRESO_JSON}`);

  return faltantes;
}

// 2. Función de subida individual
async function uploadFile(fileName) {
  const localPath = path.join(LOCAL_FOLDER, fileName);
  const remotePath = `${STORAGE_DESTINATION_FOLDER}/${fileName}`;
  try {
    await bucket.upload(localPath, {
      destination: remotePath,
      resumable: false,
      validation: false,
    });
    return { success: true, fileName };
  } catch (error) {
    return { success: false, fileName, error: error.message };
  }
}

// --- HILO PRINCIPAL ---
(async () => {
  console.clear();
  console.log("🚀 Sincronizador Maestro con Resume - v1.0");
  console.log("------------------------------------------");

  let queue = [];

  // PASO 1: Determinar estado
  if (fs.existsSync(FILE_PROGRESO_JSON)) {
    const rawData = fs.readFileSync(FILE_PROGRESO_JSON);
    queue = JSON.parse(rawData);

    if (queue.length === 0) {
      console.log("📂 El archivo progreso.json existe pero está vacío.");
      console.log(
        "   ¿Deseas escanear de nuevo? Borra el archivo json y reinicia."
      );
      process.exit(0);
    }

    console.log(`⚠️  SESIÓN RECUPERADA DETECTADA`);
    console.log(`   Archivos pendientes de subir: ${queue.length}`);
  } else {
    // Si no existe, creamos la lista desde cero
    queue = generarColaDeTrabajo();
  }

  // PASO 2: Confirmación del usuario
  console.log("\n------------------------------------------");
  const answer = await askQuestion(
    `👉 ¿Deseas comenzar la subida de ${queue.length} archivos ahora? (s/n): `
  );

  if (answer.toLowerCase() !== "s") {
    console.log("⏸️  Operación cancelada por el usuario.");
    console.log(
      "   Tu lista de faltantes sigue guardada en 'progreso.json' para la próxima."
    );
    process.exit(0);
  }

  // PASO 3: Procesamiento por lotes
  console.log("\n⬆️  Iniciando carga...");
  let totalProcessed = 0;
  const initialTotal = queue.length;

  while (queue.length > 0) {
    // Tomamos un lote del inicio del array
    const batch = queue.slice(0, CONCURRENCY_LIMIT);

    // Procesar lote en paralelo
    const results = await Promise.all(batch.map((f) => uploadFile(f)));

    // Filtramos los que se subieron bien para sacarlos de la cola
    const successFiles = results
      .filter((r) => r.success)
      .map((r) => r.fileName);
    const failedFiles = results.filter((r) => !r.success);

    // Si hubo fallos, los mostramos pero NO los sacamos de la cola (o decidimos sacarlos para reintentar luego)
    // Estrategia: Sacamos los exitosos de la cola 'queue'.
    // Los fallidos se quedan en la lógica de array (al usar slice, debemos reconstruir la cola).

    // MEJOR ESTRATEGIA PARA "RESUME":
    // Eliminamos del JSON solo los que tuvieron éxito.
    // Los que fallaron se quedarán en el JSON para la próxima ejecución.

    if (successFiles.length > 0) {
      // Filtramos la cola para quitar los que ya subimos con éxito
      // (Usamos Set para velocidad en el filtro)
      const uploadedSet = new Set(successFiles);
      queue = queue.filter((f) => !uploadedSet.has(f));

      // GUARDAMOS EL ESTADO ACTUALIZADO
      fs.writeFileSync(FILE_PROGRESO_JSON, JSON.stringify(queue, null, 2));
    }

    if (failedFiles.length > 0) {
      console.error("\n❌ Errores en este lote:");
      failedFiles.forEach((f) =>
        console.error(`   - ${f.fileName}: ${f.error}`)
      );
      // Nota: Al no sacarlos de 'queue', si reinicias el script, intentará subirlos de nuevo.
    }

    totalProcessed += batch.length; // Esto es aproximado para la barra visual
    const remaining = queue.length;
    const percent = Math.round(
      ((initialTotal - remaining) / initialTotal) * 100
    );

    process.stdout.write(
      `⏳ Progreso: ${percent}% | Faltan: ${remaining} | Último lote OK: ${successFiles.length}\r`
    );
  }

  console.log("\n\n🏁 ¡PROCESO TERMINADO!");
  console.log("   Borrando archivo de progreso...");

  // Limpieza final
  if (fs.existsSync(FILE_PROGRESO_JSON)) {
    fs.unlinkSync(FILE_PROGRESO_JSON);
  }

  console.log("✨ Todos los archivos han sido subidos.");
  process.exit(0);
})();
