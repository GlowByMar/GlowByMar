const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

// MODELO DE BASE DE DATOS PARA PEDIDOS
const pedidoSchema = new mongoose.Schema({
    idPedido: String,
    fecha: { type: Date, default: Date.now },
    cliente: String,
    contacto: String,
    direccion: String,
    productos: Array,
    total: Number,
    estado: { type: String, default: 'PENDIENTE' }
});
const Pedido = mongoose.model('Pedido', pedidoSchema, 'pedidos');

// 👉 MODELO DE BASE DE DATOS PARA PRODUCTOS (FALTABA ESTE)
const productoSchema = new mongoose.Schema({
    nombre: String,
    categoria: String,
    precioVenta: Number,
    precio: Number,
    descuento: Number
});
const Producto = mongoose.model('Producto', productoSchema, 'productos');

const app = express();

// // Configuración de Middlewares Básicos
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// // CONFIGURACIÓN DE RUTAS ESTÁTICAS Y DIRECTORIOS
app.use('/', express.static(path.join(__dirname, '../public')));
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));

// // CONFIGURACIÓN DE MULTER (Memoria temporal para Cloudinary)
const storage = multer.diskStorage({});
const upload = multer({ storage: storage });

// // CONFIGURACIÓN DE CLOUDINARY
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// CONEXIÓN A MONGODB ATLAS
mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log('¡Conectado exitosamente a MongoDB Atlas!'))
  .catch(err => console.error('Error al conectar a MongoDB:', err));


// Variable global para controlar las promociones del panel
let ofertasTemporales = {
    global: 0,
    categoria: "",
    porcentajeCategoria: 0
};

// ==========================================
// RUTA 1: Traer todos los productos (VERSIÓN UNIFICADA Y BLINDADA)
// ==========================================
app.get('/api/productos', async (req, res) => {
    try {
        // Cambia esto en tu Ruta 1:
let productos = await Producto.find({}).sort({ _id: -1 });

        let productosProcesados = productos.map(doc => {
            const prod = doc.toObject();

            // Unificamos nombres para que el frontend nunca reciba "undefined"
            const precioFinal = prod.precioVenta || prod.precio || 0;
            const stockFinal = prod.cantidadStock !== undefined ? prod.cantidadStock : (prod.stock !== undefined ? prod.stock : 0);
            const costoFinal = prod.costoCompra || prod.costo || 0;
            
            // Aseguramos que la imagen coja la de Cloudinary o una por defecto si no tiene
            let imagenFinal = prod.imagen || prod.foto || '';
            if (!imagenFinal || imagenFinal.includes('default.jpg')) {
            imagenFinal = ''; 
            }
            

            const descIndividual = parseInt(prod.descuento || prod.descIndividual || 0);
            const descGlobal = ofertasTemporales && ofertasTemporales.global ? parseInt(ofertasTemporales.global) : 0;

            let descCategoria = 0;
            if (ofertasTemporales && ofertasTemporales.categoria && prod.categoria) {
                const catOferta = ofertasTemporales.categoria.toUpperCase().trim();
                const catProducto = prod.categoria.toUpperCase().trim();

                const coincidenExacto = (catOferta === catProducto);
                const ofertaEsPlural = (catOferta === catProducto + 'S' || catOferta === catProducto + 'ES');
                const productoEsPlural = (catProducto === catOferta + 'S' || catProducto === catOferta + 'ES');

                if (coincidenExacto || ofertaEsPlural || productoEsPlural) {
                    descCategoria = parseInt(ofertasTemporales.porcentajeCategoria || 0);
                }
            }

            let descuentoApplied = 0;
            if (descIndividual > 0) descuentoApplied = descIndividual;
            else if (descCategoria > 0) descuentoApplied = descCategoria;
            else if (descGlobal > 0) descuentoApplied = descGlobal;

            return {
                ...prod,
                _id: prod._id, // Aseguramos que viaje el ID de MongoDB
                precio: precioFinal,
                precioVenta: precioFinal,
                stock: stockFinal,
                cantidadStock: stockFinal,
                costo: costoFinal,
                costoCompra: costoFinal,
                imagen: imagenFinal, // <--- Aquí va el link eterno de Cloudinary
                foto: imagenFinal,
                descuentoEfectivo: descuentoApplied, 
                precioConDescuento: precioFinal - (precioFinal * (descuentoApplied / 100))
            };
        });

        res.json(productosProcesados);

    } catch (e) {
        console.error('Error en Ruta 1:', e);
        res.status(500).json({ mensaje: 'Error al procesar los productos desde MongoDB.' });
    }
});

// ==========================================
// RUTA 2: Recibir el accesorio nuevo y guardarlo en la nube (BLINDADA)
// ==========================================
app.post('/api/productos', upload.any(), async (req, res) => {
    try {
        const { nombre, categoria, precio, costo, stock, descripcion, descuento } = req.body;

        // Buscamos el archivo sin importar si el input se llamó 'foto', 'imagen' o cualquier otra cosa
        const archivoSubido = req.files && req.files.length > 0 ? req.files[0] : null;

        if (!archivoSubido) {
            return res.status(400).json({ exito: false, mensaje: "Falta la foto del accesorio." });
        }

        // 1. Enviamos la foto física directamente a tu cuenta de Cloudinary
        const resultadoCloudinary = await cloudinary.uploader.upload(archivoSubido.path, {
            folder: "glowbymar_tienda" // Carpeta organizada en tu nube
        });

        // 2. Armamos la información para MongoDB con el enlace eterno de la foto
        const nuevoProducto = new Producto({
            nombre: nombre,
            categoria: categoria,
            precioVenta: parseInt(precio || 0),
            costoCompra: parseFloat(costo || 0),
            cantidadStock: parseInt(stock || 0),
            descuento: parseInt(descuento || 0),
            imagen: resultadoCloudinary.secure_url // Link eterno de Cloudinary
        });

        // 3. Guardamos los datos en tu base de datos
        await nuevoProducto.save();

        res.json({ 
            exito: true, 
            mensaje: "¡Accesorio guardado con éxito en MongoDB y Cloudinary!" 
        });

    } catch (error) {
        console.error("Error al registrar el accesorio:", error);
        res.status(500).json({ 
            exito: false, 
            mensaje: "Hubo un error interno en el servidor al subir la mercancía." 
        });
    }
});

// ==========================================
// RUTA 3: Procesar la compra, validar stock en MongoDB y subir comprobante a Cloudinary
// ==========================================
app.post('/api/comprar', upload.single('comprobante'), async (req, res) => {
    try {
        const { nombre, telefono, direccion } = req.body;

        // 1. Validaciones iniciales del formulario
        if (!req.body.carrito) {
            return res.status(400).json({ exito: false, mensaje: 'El carrito está vacío.' });
        }
        if (!req.file) {
            return res.status(400).json({ exito: false, mensaje: 'Falta el comprobante de pago.' });
        }

        const productosComprados = JSON.parse(req.body.carrito);

        // 2. REVISIÓN Y DESCUENTO DE STOCK EN MONGODB ATLAS (Lógica de inventario)
        for (const item of productosComprados) {
            const productoEnBD = await Producto.findById(item._id || item.id);
            
            if (!productoEnBD) {
                return res.status(404).json({ exito: false, mensaje: `El producto ${item.nombre} no existe en el inventario.` });
            }

            // Validamos si hay existencias suficientes
            const stockActual = productoEnBD.cantidadStock || productoEnBD.stock || 0;
            if (stockActual < item.cantidad) {
                return res.status(400).json({ exito: false, mensaje: `Stock insuficiente para ${item.nombre}. Disponibles: ${stockActual}` });
            }

            // Restamos la cantidad comprada directamente en la base de datos
            productoEnBD.cantidadStock = stockActual - item.cantidad;
            await productoEnBD.save();
        }

        // 3. SUBIDA DEL COMPROBANTE FÍSICO A CLOUDINARY
        const resultadoCloud = await cloudinary.uploader.upload(req.file.path, {
            folder: "glowbymar_comprobantes"
        });

        // 4. REGISTRO DEL PEDIDO EN MONGODB ATLAS
        const nuevoPedido = new Pedido({
            idPedido: "PED-" + Date.now(),
            fecha: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
            cliente: nombre,
            contacto: telefono,
            direccion: direccion,
            productos: productosComprados,
            total: productosComprados.reduce((sum, p) => sum + (p.precioConDescuento || p.precio || 0) * (p.cantidad || 1), 0),
            estado: 'PENDIENTE',
            comprobante: resultadoCloud.secure_url // Link eterno de la foto del pago
        });

        await nuevoPedido.save();

        res.json({ 
            exito: true, 
            mensaje: "¡Tu compra fue registrada con éxito! El administrador verificará tu pago e inventario." 
        });

    } catch (error) {
        console.error("Error al procesar la compra en la nube:", error);
        res.status(500).json({ 
            exito: false, 
            mensaje: "Hubo un problema interno en el servidor al procesar la transacción." 
        });
    }
});

// ==========================================
// RUTA 4: Eliminar un producto
// ==========================================
app.delete('/api/productos/:id', (req, res) => {
    const idBuscar = parseInt(req.params.id);
    const rutaArchivo = path.join(__dirname, 'productos.json'); 
    fs.readFile(rutaArchivo, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ exito: false, mensaje: "Error al leer BD" });
        let productos = JSON.parse(data || '[]');
        const filtrados = productos.filter(p => p.id !== idBuscar);
        fs.writeFile(rutaArchivo, JSON.stringify(filtrados, null, 2), (err) => {
            if (err) return res.status(500).json({ exito: false, mensaje: "Error al guardar BD" });
            res.json({ exito: true, mensaje: "Producto eliminado." });
        });
    });
});

// // RUTA 5: Traer todos los pedidos realizados directamente desde MongoDB Atlas
app.get('/api/pedidos', async (req, res) => {
    try {
        // Busca todos los pedidos guardados en la nube organizados por los más recientes
        const pedidos = await Pedido.find({});
        res.json(pedidos);
    } catch (error) {
        console.error('Error al traer pedidos de MongoDB:', error);
        res.json([]); // Si falla, devuelve una lista vacía para que no se rompa el panel
    }
});

// ==========================================
// // RUTA 6: Despachar un pedido asignando transportadora y guía en MongoDB Atlas
app.put('/api/pedidos/:id/despachar', async (req, res) => {
    try {
        const idPedido = req.params.id;
        const { transportadora, numeroGuia } = req.body;

        // Buscamos el pedido en la nube y le actualizamos sus campos en un segundo
        const pedidoActualizado = await Pedido.findOneAndUpdate(
            { idPedido: idPedido },
            { 
                estado: 'Despachado',
                transportadora: transportadora,
                numeroGuia: numeroGuia
            },
            { new: true }
        );

        if (!pedidoActualizado) return res.status(404).json({ exito: false, mensaje: "Pedido no encontrado." });

        res.json({ exito: true, mensaje: "¡Pedido marcado como despachado con éxito!" });
    } catch (error) {
        console.error("Error al despachar:", error);
        res.status(500).json({ exito: false, mensaje: "Error interno al despachar el pedido." });
    }
});

// // RUTA 7: Entregar un pedido cambiando su estado final en MongoDB Atlas
app.put('/api/pedidos/:id/entregar', async (req, res) => {
    try {
        const idPedido = req.params.id;

        const pedidoActualizado = await Pedido.findOneAndUpdate(
            { idPedido: idPedido },
            { estado: 'Entregado' },
            { new: true }
        );

        if (!pedidoActualizado) return res.status(404).json({ exito: false, mensaje: "Pedido no encontrado." });

        res.json({ exito: true, mensaje: "¡Pedido marcado como entregado de forma permanente!" });
    } catch (error) {
        console.error("Error al entregar:", error);
        res.status(500).json({ exito: false, mensaje: "Error interno al entregar el pedido." });
    }
});

// ==========================================
// RUTA 8: Factura HTML corregida con Descuentos
// ==========================================
app.get('/api/pedidos/:id/factura', (req, res) => {
    const idBuscar = parseInt(req.params.id);
    const rutaPedidos = path.join(__dirname, 'pedidos.json');
    
    // 1. Leemos y parseamos de forma segura
    let pedidos = [];
    try {
        const data = fs.readFileSync(rutaPedidos, 'utf8');
        pedidos = JSON.parse(data || '[]');
    } catch (e) {
        return res.status(500).send("<h1>Error al leer la base de datos de pedidos</h1>");
    }

    // 2. Buscamos el pedido
    const pedido = pedidos.find(p => p.idPedido === idBuscar);

    // 3. Validamos la existencia antes de cualquier cosa
    if (!pedido) {
        return res.status(404).send("<h1>El pedido no existe</h1>");
    }

    // 4. Si llegamos aquí, 'pedido' existe. 
    // Asegúrate de que 'pedido.fecha' sea un string válido. 
    // Si la fecha da error, prueba imprimiendo solo el objeto para depurar.
    try {
        const htmlFactura = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <title>Factura de Venta #${pedido.idPedido}</title>
        <style>
            body { font-family: 'Segoe UI', sans-serif; color: #333; padding: 40px; background-color: #fafafa; }
            .factura-box { max-width: 800px; margin: auto; padding: 30px; background: #fff; border: 1px solid #eee; border-radius: 8px; }
            .header-container { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #333; padding-bottom: 20px; }
            .columnas-datos { display: flex; justify-content: space-between; margin: 20px 0; gap: 20px; }
            .columna { flex: 1; background: #f9f9f9; padding: 15px; border-radius: 6px; border-left: 4px solid #2c3e50; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th { background: #2c3e50; color: white; padding: 10px; font-size: 12px; }
            td { padding: 10px; border-bottom: 1px solid #eee; font-size: 13px; }
            .total-box { background: #2c3e50; color: white; padding: 15px; border-radius: 6px; text-align: right; margin-top: 20px; width: 280px; margin-left: auto; }
        </style>
    </head>
    <body>
    <div class="factura-box">
        <div class="header-container">
            <div><h2>GLOW BY MAR</h2><p>Accesorios y Joyería Premium</p></div>
            <img src="/imagenes/logo.png" onerror="this.src='https://cdn-icons-png.flaticon.com/512/3081/3081559.png'" style="width:70px;">
        </div>
        <div class="columnas-datos">
            <div class="columna">
                <h3>Cliente</h3>
                <p><strong>Nombre:</strong> ${pedido.cliente}</p>
                <p><strong>Teléfono:</strong> ${pedido.telefono}</p>
                <p><strong>Dirección:</strong> ${pedido.direccion}</p>
            </div>
            <div class="columna">
                <h3>Venta</h3>
                <p><strong>Factura:</strong> #00${pedido.idPedido}</p>
                <p><strong>Fecha:</strong> ${pedido.fecha}</p>
            </div>
        </div>
        <table>
            <thead>
                <tr>
                    <th>Artículo</th>
                    <th style="text-align:center;">Cant.</th>
                    <th style="text-align:right;">Precio</th>
                    <th style="text-align:center;">Desc.</th>
                    <th style="text-align:right;">Precio Oferta</th>
                    <th style="text-align:right;">Subtotal</th>
                </tr>
            </thead>
            <tbody>
    ${(pedido.articulosDetallados || []).map(art => `
        <tr>
            <td><strong>${art.nombre || 'Producto'}</strong></td>
            <td style="text-align:center;">${art.cantidad || 0}</td>
            <td style="text-align:right;">$${(art.precioOriginal || 0).toLocaleString('es-CO')}</td>
            <td style="text-align:center;">${art.descuentoAplicado || 0}%</td>
            <td style="text-align:right;">$${(art.precioEfectivoUnidad || 0).toLocaleString('es-CO')}</td>
            
            <td style="text-align:right; font-weight:bold;">$${(art.subtotal || 0).toLocaleString('es-CO')}</td>
        </tr>
    `).join('')}
</tbody>
        </table>
        <div class="total-box">
            <p>Total Neto Pagado</p>
            <h2 style="margin:5px 0 0 0; color:#2ecc71;">$${parseInt(pedido.total || 0).toLocaleString('es-CO')} COP</h2>
        </div>
    </div>
    </body>
    </html>`;
    res.send(htmlFactura);
    } catch (error) {
        res.status(500).send("<h1>Error al generar el HTML de la factura</h1>");
    }
});

// ==========================================
// RUTA NUEVA/CORREGIDA: Generar Factura en PDF para WhatsApp
// ==========================================
app.get('/api/pedidos/:id/pdf', (req, res) => {
    const idBuscar = parseInt(req.params.id);
    const rutaPedidos = path.join(__dirname, 'pedidos.json'); 
    const pedidos = JSON.parse(fs.readFileSync(rutaPedidos, 'utf-8') || '[]');
    const pedido = pedidos.find(p => p.idPedido === idBuscar);

    if (!pedido) return res.status(404).send("El pedido no existe.");

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=factura-${pedido.idPedido}.pdf`);
    doc.pipe(res);

    doc.fontSize(20).text('GLOW BY MAR', { align: 'center' });
    doc.fontSize(10).text('Accesorios y Joyería Premium', { align: 'center' }).moveDown(2);

    doc.fontSize(11).text(`Factura Nro: #00${pedido.idPedido}`);
    doc.text(`Fecha: ${pedido.fecha}`).moveDown();
    doc.text(`Cliente: ${pedido.cliente}`);
    doc.text(`Teléfono: ${pedido.telefono}`);
    doc.text(`Dirección: ${pedido.direccion}`).moveDown(2);

    doc.text('DETALLE DE PRODUCTOS:', { underline: true }).moveDown(0.5);
    
    (pedido.articulosDetallados || []).forEach(art => {
        doc.text(`- ${art.nombre} x${art.cantidad} | Base: $${art.precioOriginal.toLocaleString('es-CO')} (-${art.descuentoAplicado}%) -> Oferta: $${art.precioEfectivoUnidad.toLocaleString('es-CO')} COP c/u`);
    });

    doc.moveDown(2);
    doc.fontSize(13).text(`TOTAL NETO PAGADO: $${parseInt(pedido.total || 0).toLocaleString('es-CO')} COP`, { align: 'right', bold: true });
    doc.end();
});

// ==========================================
// RUTA 9: Reporte Mensual DETALLADO
// ==========================================
app.get('/api/reportes/mensual', (req, res) => {
    const rutaPedidos = path.join(__dirname, 'pedidos.json');
    if (!fs.existsSync(rutaPedidos)) return res.status(404).send("<h1>No hay datos aún</h1>");

    const pedidos = JSON.parse(fs.readFileSync(rutaPedidos, 'utf-8') || '[]');
    const resumenMeses = {};
    let granTotalCaja = 0;

    // 1. PROCESAMIENTO: Aquí solo calculamos y guardamos en 'resumenMeses'
    pedidos.forEach(p => {
        let mesAnio = 'General';
        if (p.fecha) {
            const partes = p.fecha.replace(/\s+/g, '').split('/');
            if (partes.length >= 3) mesAnio = `${partes[1]}/${partes[2].substring(0, 4)}`;
        }

        const valorPedido = parseInt(p.total || 0);
        granTotalCaja += valorPedido;

        if (!resumenMeses[mesAnio]) {
            resumenMeses[mesAnio] = { totalVentas: 0, cantidadPedidos: 0, listaDetallada: [] };
        }
        
        resumenMeses[mesAnio].totalVentas += valorPedido;
        resumenMeses[mesAnio].cantidadPedidos += 1;

        if (p.articulosDetallados) {
            p.articulosDetallados.forEach(art => {
                resumenMeses[mesAnio].listaDetallada.push({
                    nombre: art.nombre,
                    cantidad: art.cantidad,
                    costo: (JSON.parse(fs.readFileSync(path.join(__dirname, 'productos.json'), 'utf8')).find(p => p.nombre === art.nombre) || {costo: 0}).costo,
                    precioOriginal: art.precioOriginal || 0, // Asegúrate de que este nombre coincida con tu JSON
                    subtotal: art.subtotal,
                    precioPromocion: (art.precioEfectivoUnidad && art.precioEfectivoUnidad !== art.precioOriginal) ? art.precioEfectivoUnidad : 0,
                    ganancia: ((art.precioPromocion || (art.subtotal / art.cantidad)) - (JSON.parse(fs.readFileSync(path.join(__dirname, 'productos.json'), 'utf8')).find(p => p.nombre === art.nombre) || {costo: 0}).costo) * art.cantidad,
                    obs: p.obs || "Venta Web" // <--- Hereda la observación del pedido
                });
                });
            
        }
    
    });

    // 2. GENERACIÓN: Construimos el HTML una vez que los datos están listos
    const htmlReporte = `
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <title>Reporte Detallado</title>
            <style>
                body { font-family: sans-serif; padding: 20px; }
                .ciclo-bloque { margin-bottom: 20px; border: 1px solid #ccc; padding: 10px; }
                table { width: 100%; border-collapse: collapse; }
                th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            </style>
        </head>
        <body>
            <h1>GLOW BY MAR - Reporte Detallado</h1>
            ${Object.keys(resumenMeses).map(mes => `
                <div class="ciclo-bloque">
                    <h3>Ciclo: ${mes}</h3>
                    <table>
                        <thead>
                            <tr>
                                <th>Producto</th>
                                <th>Unidades</th>
                                <th>Costo</th>
                                <th>Precio Catálogo</th>
                                <th>Precio Venta</th>
                                <th>Ganancia</th>
                                <th>Total Neto</th>
                                <th>OBS</th>
                            </tr>
                        </thead>
                        <tbody>
    ${(() => {
        // 1. Calculamos las sumas aquí dentro
        const lista = resumenMeses[mes].listaDetallada;
        // Actualiza esta parte de tu código:
const sums = lista.reduce((acc, art) => ({
    costo: acc.costo + (art.costo || 0),
    precioOrig: acc.precioOrig + (art.precioOriginal || 0),
    // CAMBIO AQUÍ: usamos la misma lógica que en la celda de la tabla
    precioProm: acc.precioProm + (art.precioPromocion || art.precioOriginal || 0),
    ganancia: acc.ganancia + (art.ganancia || 0),
    subtotal: acc.subtotal + (art.subtotal || 0)
}), { costo: 0, precioOrig: 0, precioProm: 0, ganancia: 0, subtotal: 0 });

        // 2. Pintamos las filas y el total al final
        return `
            ${lista.map(art => `
                <tr>
                    <td>${art.nombre}</td>
                    <td>${art.cantidad}</td>
                    <td>$${(art.costo || 0).toLocaleString('es-CO')}</td>
                    <td>$${(art.precioOriginal || 0).toLocaleString('es-CO')}</td>
                    <td>$${(art.precioPromocion || art.precioOriginal || 0).toLocaleString('es-CO')}</td>
                    <td>$${(art.ganancia || 0).toLocaleString('es-CO')}</td>
                    <td>$${(art.subtotal || 0).toLocaleString('es-CO')}</td>
                    <td><b>${art.obs || "Venta Web"}</b></td> <!-- <--- Muestra si es Externa o Web -->
                </tr>
            `).join('')}
            <tr style="font-weight: bold; background-color: #f8f8f8;">
                <td colspan="2">TOTAL CICLO</td>
                <td>$${sums.costo.toLocaleString('es-CO')}</td>
                <td>$${sums.precioOrig.toLocaleString('es-CO')}</td>
                <td>$${sums.precioProm.toLocaleString('es-CO')}</td>
                <td>$${sums.ganancia.toLocaleString('es-CO')}</td>
                <td>$${sums.subtotal.toLocaleString('es-CO')}</td>
                <td>-</td> <!-- Espacio vacío para la columna OBS en la fila de totales -->
            </tr>
        `;
    })()}
</tbody>
                    </table>
                </div>
            `).join('')}
            <h2>Total Histórico: $${granTotalCaja.toLocaleString('es-CO')}</h2>
        </body>
        </html>
    `;

    // 3. RESPUESTA: Enviamos todo junto al final
    res.send(htmlReporte);
});

// ====================================================
// ✅ NUEVA RUTA: OFERTAS MASIVAS PERSISTENTES
// ====================================================
app.post('/api/ofertas/activar', (req, res) => {
    const { tipo, porcentaje, categoria } = req.body;
    const rutaArchivo = path.join(__dirname, 'productos.json');

    fs.readFile(rutaArchivo, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ exito: false, mensaje: 'Error al leer productos.' });
        
        let productos = JSON.parse(data || '[]');
        const nuevoDescuento = parseInt(porcentaje || 0);

        productos = productos.map(prod => {
            if (tipo === 'global' || (tipo === 'categoria' && prod.categoria === categoria)) {
                return { ...prod, descuento: nuevoDescuento };
            }
            return prod;
        });

        fs.writeFile(rutaArchivo, JSON.stringify(productos, null, 2), (errWrite) => {
            if (errWrite) {
                return res.status(500).json({ exito: false, mensaje: 'Error al guardar.' });
            }
            return res.json({ exito: true, mensaje: "¡Oferta aplicada permanentemente!" });
        });
    });
});

// ====================================================
// 🔥 RUTA CORREGIDA: Editar un producto existente (MongoDB + Cloudinary)
// ====================================================
app.post('/api/productos/editar', upload.any(), async (req, res) => {
    try {
        const { id, nombre, precio, costo, stock, categoria, descripcion, descuento } = req.body;

        if (!id) {
            return res.status(400).json({ exito: false, mensaje: "Falta el ID del producto a editar." });
        }

        // 1. Buscamos el producto actual en MongoDB para saber si ya tenía imagen
        const productoExistente = await Producto.findById(id);
        if (!productoExistente) {
            return res.status(404).json({ exito: false, mensaje: "El producto no existe en la base de datos." });
        }

        let nuevaImagenUrl = productoExistente.imagen || productoExistente.foto;

        // 2. Verificamos si el usuario subió una NUEVA foto en el formulario
        const archivoSubido = req.files && req.files.length > 0 ? req.files[0] : null;

        if (archivoSubido) {
            // Si hay archivo nuevo, lo mandamos a Cloudinary
            const resultadoCloudinary = await cloudinary.uploader.upload(archivoSubido.path, {
                folder: "glowbymar_tienda"
            });
            nuevaImagenUrl = resultadoCloudinary.secure_url;
        }

        // 3. Actualizamos el producto en MongoDB
        await Producto.findByIdAndUpdate(id, {
            nombre: nombre,
            categoria: categoria,
            precioVenta: parseInt(precio || 0),
            costoCompra: parseFloat(costo || 0),
            cantidadStock: parseInt(stock || 0),
            descripcion: descripcion,
            descuento: parseInt(descuento || 0),
            imagen: nuevaImagenUrl,
            foto: nuevaImagenUrl
        });

        res.json({ 
            exito: true, 
            mensaje: '¡Producto actualizado con éxito en MongoDB y Cloudinary!' 
        });

    } catch (error) {
        console.error("Error al editar el producto:", error);
        res.status(500).json({ 
            exito: false, 
            mensaje: 'Error interno al procesar la actualización.' 
        });
    }
});

app.post('/api/ofertas/desactivar', (req, res) => {
    const rutaArchivo = path.join(__dirname, 'productos.json');

    fs.readFile(rutaArchivo, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ exito: false });
        
        let productos = JSON.parse(data || '[]');
        
        // Ponemos el descuento en 0 a TODOS los productos
        productos = productos.map(prod => ({ ...prod, descuento: 0 }));

        fs.writeFile(rutaArchivo, JSON.stringify(productos, null, 2), (errWrite) => {
            if (errWrite) return res.status(500).json({ exito: false });
            res.json({ exito: true, mensaje: "Ofertas desactivadas correctamente." });
        });
    });
});

// ==========================================
// RUTA: Registrar Venta Externa por Nombre
// ==========================================
app.post('/api/registrar-venta', (req, res) => {
    try {
        const { nombreProducto, cantidad, tipoVenta, cliente } = req.body; 

        if (!nombreProducto || !cantidad) {
            return res.status(400).json({ exito: false, mensaje: 'Faltan datos del producto.' });
        }

        const rutaProductos = path.join(__dirname, 'productos.json');
        const rutaPedidos = path.join(__dirname, 'pedidos.json');

        const productos = JSON.parse(fs.readFileSync(rutaProductos, 'utf-8') || '[]');
        
        // Buscamos directamente por el nombre (ignorando mayúsculas/minúsculas para evitar errores)
        const prodBD = productos.find(p => p.nombre && p.nombre.toLowerCase() === nombreProducto.trim().toLowerCase());

        if (!prodBD) {
            return res.status(400).json({ exito: false, mensaje: 'El producto no existe en el inventario.' });
        }

        const stockActual = prodBD.stock !== undefined ? prodBD.stock : (prodBD.disponibles || 0);
        if (stockActual < Number(cantidad)) {
            return res.status(400).json({ exito: false, mensaje: `Stock insuficiente. Solo quedan ${stockActual} unidades.` });
        }

        // Cálculos exactos para su reporte mensual
        const precioOriginal = prodBD.precio || 0;
        const costo = prodBD.costo || 0;
        const descuento = prodBD.descIndividual || prodBD.descuento || 0;
        const precioEfectivo = descuento > 0 ? precioOriginal - (precioOriginal * (descuento / 100)) : precioOriginal;
        const subtotal = precioEfectivo * Number(cantidad);

        // Descontar stock
        if (prodBD.stock !== undefined) {
            prodBD.stock -= Number(cantidad);
        } else if (prodBD.disponibles !== undefined) {
            prodBD.disponibles -= Number(cantidad);
        }
        fs.writeFileSync(rutaProductos, JSON.stringify(productos, null, 2));

        // Registrar en pedidos.json con la estructura idéntica del reporte
        const pedidos = JSON.parse(fs.readFileSync(rutaPedidos, 'utf-8') || '[]');
        
        const nuevoPedido = {
            idPedido: pedidos.length > 0 ? pedidos[pedidos.length - 1].idPedido + 1 : 1,
            fecha: new Date().toLocaleString('es-CO'),
            obs: tipoVenta || "Venta Web", 
            cliente: cliente || "Cliente Presencial",
            telefono: "N/A",
            direccion: "Tienda Física",
            total: subtotal,
            articulosDetallados: [{
                nombre: prodBD.nombre,
                cantidad: Number(cantidad),
                costo: costo,
                precioOriginal: precioOriginal,
                descuentoAplicado: descuento,
                precioEfectivoUnidad: precioEfectivo,
                subtotal: subtotal
            }],
            articulos: [`${prodBD.nombre} (x${cantidad})`]
        };

        pedidos.push(nuevoPedido);
        fs.writeFileSync(rutaPedidos, JSON.stringify(pedidos, null, 2));

        return res.status(200).json({ exito: true, mensaje: '¡Venta registrada con éxito en el reporte!' });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ exito: false, mensaje: 'Error interno en el servidor.' });
    }
});
// Intento de despliegue final
// ==========================================
// 🔥 ARRANCAR MOTOR DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de la tienda corriendo exitosamente en el puerto ${PORT}`);
});