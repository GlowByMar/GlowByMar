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
    fecha: String,
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
    costoCompra: Number,
    cantidadStock: Number,
    descuento: Number,
    imagen: String,
    foto: String
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
const upload = multer({ storage: multer.memoryStorage() });

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
// RUTA 1: Traer todos los productos desde MongoDB
// ==========================================
app.get('/api/productos', async (req, res) => {
    try {
        let productos = await Producto.find({}).sort({ _id: -1 });

        let productosProcesados = productos.map(doc => {
            const prod = doc.toObject();

            const precioFinal = prod.precioVenta || prod.precio || 0;
            const stockFinal = prod.cantidadStock !== undefined ? prod.cantidadStock : (prod.stock !== undefined ? prod.stock : 0);
            const costoFinal = prod.costoCompra || prod.costo || 0;
            
            let imagenFinal = prod.imagen || prod.foto || '';
            if (!imagenFinal || imagenFinal.includes('default.jpg')) {
                imagenFinal = ''; 
            }
            
            // El descuento sale unificadamente del campo que ya tenga guardado el producto en Mongo
            const descuentoApplied = parseInt(prod.descuento || prod.descIndividual || prod.descuentoIndividual || 0);

            return {
                ...prod,
                _id: prod._id,
                precio: precioFinal,
                precioVenta: precioFinal,
                stock: stockFinal,
                cantidadStock: stockFinal,
                costo: costoFinal,
                costoCompra: costoFinal,
                imagen: imagenFinal,
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

// ====================================================
// ✅ RUTA DE OFERTAS MASIVAS DIRECTO A MONGODB
// ====================================================
app.post('/api/ofertas/activar', async (req, res) => {
    const { tipo, porcentaje, categoria } = req.body;
    const nuevoDescuento = parseInt(porcentaje || 0);

    try {
        if (tipo === 'global') {
            // Actualiza TODOS los productos de la base de datos
            await Producto.updateMany({}, { $set: { descuento: nuevoDescuento, descIndividual: nuevoDescuento } });
            return res.json({ exito: true, mensaje: "¡Oferta global aplicada a toda la tienda!" });
        } 
        
        if (tipo === 'categoria' && categoria) {
            // Actualiza solo los productos que coincidan con la categoría
            await Producto.updateMany(
                { categoria: { $regex: new RegExp('^' + categoria + '$', 'i') } }, 
                { $set: { descuento: nuevoDescuento, descIndividual: nuevoDescuento } }
            );
            return res.json({ exito: true, mensaje: `¡Oferta aplicada a la categoría ${categoria}!` });
        }

        res.status(400).json({ exito: false, mensaje: "Tipo de oferta inválido." });
    } catch (error) {
        console.error('Error al activar ofertas masivas:', error);
        res.status(500).json({ exito: false, mensaje: 'Error en el servidor al aplicar la oferta.' });
    }
});

// ====================================================
// ✅ RUTA PARA DESACTIVAR OFERTAS MASIVAS EN MONGODB
// ====================================================
app.post('/api/ofertas/desactivar', async (req, res) => {
    try {
        // Pone el descuento en 0 a absolutamente todos los productos en MongoDB
        await Producto.updateMany({}, { $set: { descuento: 0, descIndividual: 0 } });
        res.json({ exito: true, mensaje: "Ofertas desactivadas correctamente en el sistema." });
    } catch (error) {
        console.error('Error al desactivar ofertas:', error);
        res.status(500).json({ exito: false, mensaje: 'Error al desactivar ofertas.' });
    }
});


// ==========================================
// RUTA 2: Recibir el accesorio nuevo y guardarlo en la nube (BLINDADA)
// ==========================================
app.post('/api/productos', upload.any(), async (req, res) => {
    try {
        let urlImagen = "";
        
        // 1. PRIMERO subimos a Cloudinary y esperamos a que termine
        if (req.files && req.files.length > 0) {
            const archivoSubido = req.files[0];
            
            const subirACloudinary = (buffer) => {
                return new Promise((resolve, reject) => {
                    const stream = cloudinary.uploader.upload_stream(
                        { folder: "glowbymar_tienda" },
                        (error, resultado) => {
                            if (error) reject(error);
                            else resolve(resultado);
                        }
                    );
                    stream.end(buffer);
                });
            };

            const resultadoCloudinary = await subirACloudinary(archivoSubido.buffer);
            urlImagen = resultadoCloudinary.secure_url;
            console.log("URL de Cloudinary lista:", urlImagen);
        }

        // 2. DESPUÉS creamos el producto con la URL ya lista
        const nuevoProducto = new Producto({
            nombre: req.body.nombre,
            categoria: req.body.categoria,
            precioVenta: parseInt(req.body.precio || req.body.precioVenta || 0),
            costoCompra: parseFloat(req.body.costo || req.body.costoCompra || 0),
            cantidadStock: parseInt(req.body.stock || req.body.cantidadStock || 0),
            descuento: parseInt(req.body.descuento || req.body.descIndividual || 0),
            imagen: urlImagen, // <--- Aquí ya viaja con el link listo
            foto: urlImagen    // <--- Aquí también
        });

        const guardado = await nuevoProducto.save();
        console.log("Producto guardado CON imagen en MongoDB:", guardado);

        res.json({ exito: true, mensaje: "¡Guardado con éxito!" });

    } catch (error) {
        console.error("Error en servidor:", error);
        res.status(500).json({ exito: false, mensaje: "Error interno" });
    }
});

async function cargarPedidosAdmin() {
    try {
        const respuesta = await fetch('/api/pedidos');
        const pedidos = await respuesta.json();
        const tabla = document.getElementById('tabla-pedidos-admin');
        
        if (!tabla) return;
        tabla.innerHTML = '';

        if (pedidos.length === 0) {
            tabla.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:20px; color:#888;">No se han registrado pedidos aún.</td></tr>`;
            const reporteElemento = document.getElementById('total-ventas-banner');
            if (reporteElemento) reporteElemento.innerText = `$0 COP`;
            return;
        }

        let totalCaja = 0; 

        pedidos.reverse().forEach(pedido => { 
            const estadoActual = pedido.estado || 'Pendiente';
            const totalNetoPedido = parseInt(pedido.total || 0);
            totalCaja += totalNetoPedido;

            let colorEstado = '#e67e22'; 
            if (estadoActual.toLowerCase() === 'despachado') colorEstado = '#3498db'; 
            if (estadoActual.toLowerCase() === 'entregado') colorEstado = '#27ae60'; 

            let botonAccionDinamico = '';
            if (estadoActual.toLowerCase() === 'pendiente') {
                botonAccionDinamico = `<button onclick="marcarDespachado('${pedido.idPedido}')" style="background: #e67e22; color: white; padding: 8px 12px; border: none; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; text-transform: uppercase;">📦 Despachar</button>`;
            } else if (estadoActual.toLowerCase() === 'despachado') {
                botonAccionDinamico = `<button onclick="marcarEntregado('${pedido.idPedido}')" style="background: #27ae60; color: white; padding: 8px 12px; border: none; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; text-transform: uppercase;">✅ Entregar</button>`;
            } else {
                botonAccionDinamico = `<span style="color: #27ae60; font-weight: bold; font-size: 11px;">🏁 VENTA FINALIZADA</span>`;
            }

            // Unificamos lectura de teléfono por si viene como .telefono o .contacto
            const telCliente = pedido.telefono || pedido.contacto || '';
            const clienteNombre = pedido.cliente || 'Cliente';

            let textoMensaje = "";
            let colorBotonWA = "#25d366";
            let etiquetaWA = "💬 WhatsApp";

            if (estadoActual.toLowerCase() === 'pendiente') {
                textoMensaje = `Hola ${clienteNombre}. Te habla Glow By Mar. Confirmamos que tu pago de $${totalNetoPedido.toLocaleString('es-CO')} COP fue recibido con éxito.`;
            } else {
                textoMensaje = `Hola ${clienteNombre}. Te habla Glow By Mar. Tu pedido ya fue despachado por: ${pedido.transportadora || 'Transportadora'} con la guía: ${pedido.numeroGuia || 'Pendiente'}, gracias por tu compra.`;
                colorBotonWA = "#3498db";
                etiquetaWA = "🚀 Notificar Envío";
            }

            const mensajeWhatsApp = encodeURIComponent(textoMensaje);
            let telefonoFormateado = telCliente.toString().trim().replace(/\s+/g, '');
            if (!telefonoFormateado.startsWith('57')) telefonoFormateado = '57' + telefonoFormateado;
            const urlWhatsApp = `https://wa.me/${telefonoFormateado}?text=${mensajeWhatsApp}`;

            // Leer productos de forma segura
            let listaArticulosText = "Productos varios";
            if (pedido.productos && Array.isArray(pedido.productos)) {
                listaArticulosText = pedido.productos.map(prod => `${prod.nombre || 'Accesorio'} (x${prod.cantidad || 1})`).join(', ');
            }

            // Validar comprobante de manera robusta
            let botonComprobante = `<span style="color: #999; font-size: 10px;">Sin pago</span>`;
            if (pedido.comprobante && pedido.comprobante.trim() !== "") {
                botonComprobante = `<a href="${pedido.comprobante}" target="_blank" style="background: #700070; color: white; padding: 8px 12px; border-radius: 6px; text-decoration: none; font-size: 11px; font-weight: bold; text-transform: uppercase;">👁️ Pago</a>`;
            }

            tabla.innerHTML += `
                <tr style="border-bottom: 1px solid #eee; height: 55px;">
                    <td style="padding: 10px; font-weight: bold;">#${pedido.idPedido}</td>
                    <td style="color: #666; font-size: 12px;">${pedido.fecha}</td>
                    <td><strong>${clienteNombre}</strong><br><small style="color:#777;">📱 ${telCliente}</small></td>
                    <td>
                        ${pedido.direccion || 'Sin dirección'}
                        <button onclick="verGuiaEnvio('${clienteNombre}', '${telCliente}', '${pedido.direccion || ''}', '${totalNetoPedido}')" style="background: none; border: none; color: #3498db; cursor: pointer; font-size: 11px; text-decoration: underline; padding: 0; display: block; margin-top:3px;">📋 Copiar Datos</button>
                    </td>
                    <td style="font-size: 12px;">${listaArticulosText}</td>
                    <td style="font-weight: bold; color: #27ae60;">$${totalNetoPedido.toLocaleString('es-CO')} COP</td>
                    <td>
                        <span style="background: ${colorEstado}; color: white; padding: 3px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; text-transform: uppercase;">${estadoActual}</span>
                    </td>
                    <td style="padding: 10px; text-align: center;">
                        <div style="display: flex; gap: 6px; justify-content: center; align-items: center; flex-wrap: wrap;">
                            ${botonComprobante}
                            <a href="${urlWhatsApp}" target="_blank" style="background: ${colorBotonWA}; color: white; padding: 8px 12px; border-radius: 6px; text-decoration: none; font-size: 11px; font-weight: bold; text-transform: uppercase;">${etiquetaWA}</a>
                            <button onclick="descargarFactura('${pedido.idPedido}')" style="background: #7f8c8d; color: white; padding: 8px 12px; border: none; border-radius: 6px; font-size: 11px; font-weight: bold; text-transform: uppercase; cursor: pointer;">📄 Factura</button>
                            ${botonAccionDinamico}
                        </div>
                    </td>
                </tr>
            `;
        });

        const reporteElemento = document.getElementById('total-ventas-banner');
        if (reporteElemento) {
            reporteElemento.innerText = `$${totalCaja.toLocaleString('es-CO')} COP`;
        }

    } catch (error) {
        console.error("Error al cargar los pedidos:", error);
    }
}

// ==========================================
// RUTA 4: Eliminar un producto de MongoDB
// ==========================================
app.delete('/api/productos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Buscamos y eliminamos el producto en MongoDB por su ID de _id
        const productoEliminado = await Producto.findByIdAndDelete(id);

        if (!productoEliminado) {
            return res.status(404).json({ exito: false, mensaje: "El producto no existe en la base de datos." });
        }

        res.json({ exito: true, mensaje: "¡Producto eliminado con éxito de MongoDB!" });
    } catch (error) {
        console.error("Error al eliminar el producto:", error);
        res.status(500).json({ exito: false, mensaje: "Error al intentar eliminar el producto." });
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
// 🔥 RUTA CORREGIDA: Editar un producto existente (MongoDB + Cloudinary)
// ====================================================
app.post('/api/productos/editar', upload.any(), async (req, res) => {
    try {
        const { id, nombre, precio, costo, stock, categoria, descripcion, descuento, descIndividual } = req.body;
        const descuentoFinal = descuento || descIndividual || 0;
        
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
            descuento: parseInt(req.body.descuento || req.body.descIndividual || 0),
            descIndividual: parseInt(req.body.descuento || req.body.descIndividual || 0),
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

// ==========================================
// RUTA: Traer todos los pedidos de MongoDB
// ==========================================
app.get('/api/pedidos', async (req, res) => {
    try {
        const pedidos = await Pedido.find({});
        res.json(pedidos);
    } catch (error) {
        console.error('Error al traer pedidos de MongoDB:', error);
        res.status(500).json([]);
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