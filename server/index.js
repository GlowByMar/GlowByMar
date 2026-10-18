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
    foto: String,
    // 🟢 NUEVO CAMPO: Sirve para separar las tiendas ('glow' o 'volk')
    tienda: { type: String, default: 'glow' } 
});

const Producto = mongoose.model('Producto', productoSchema, 'productos');

const app = express();

// // Configuración de Middlewares Básicos
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// RUTAS 0 PARA LAS DOS TIENDAS Y EL LANDING PAGE
// ==========================================

// 1. La portada principal con los dos círculos/logos
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/landing.html'));
});

// 2. Ruta para la tienda Glow
app.get('/glow', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 3. Ruta para la VOLK
app.get('/volk', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});


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

// Ponga esto abajito de su conexión a MongoDB en el index.js
Producto.updateMany({ tienda: { $exists: false } }, { $set: { tienda: 'glow' } })
    .then(() => console.log("✨ Productos antiguos marcados como 'glow' exitosamente"))
    .catch(err => console.error("Error al actualizar:", err));

    
// Variable global para controlar las promociones del panel
let ofertasTemporales = {
    global: 0,
    categoria: "",
    porcentajeCategoria: 0
};


// ==========================================
// RUTA 1: Traer productos (Con soporte para Admin y Tiendas)
// ==========================================
app.get('/api/productos', async (req, res) => {
    try {
        let filtro = {};

        // Si viene desde el admin pidiendo todo el inventario unificado:
        if (req.query.admin === 'true') {
            filtro = {}; // Sin filtro, trae TODO de la base de datos
        } else {
            // Si viene de las páginas públicas, filtra estrictamente por la tienda solicitada (por defecto 'glow')
            const tiendaSeleccionada = req.query.tienda || 'glow';
            filtro.tienda = tiendaSeleccionada;
        }

        let productos = await Producto.find(filtro).sort({ _id: -1 });

        let productosProcesados = productos.map(doc => {
            const prod = doc.toObject();

            const precioFinal = prod.precioVenta || prod.precio || 0;
            const stockFinal = prod.cantidadStock !== undefined ? prod.cantidadStock : (prod.stock !== undefined ? prod.stock : 0);
            const costoFinal = prod.costoCompra || prod.costo || 0;
            
            let imagenFinal = prod.imagen || prod.foto || '';
            if (!imagenFinal || imagenFinal.includes('default.jpg')) {
                imagenFinal = ''; 
            }
            
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
        { 
            folder: "glowbymar_tienda",
            transformation: [
                { width: 800, crop: "limit" },
                { quality: "auto", fetch_format: "auto" }
            ]
        },
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

        const categoriaSeleccionada = req.body.categoria || "";
        const nombreIngresado = req.body.nombre || "";
        
        const nombreFinal = categoriaSeleccionada ? `${categoriaSeleccionada} ${nombreIngresado}`.trim() : nombreIngresado;

        // 🌟 CAPTURAMOS LA TIENDA QUE VIENE DESDE EL FORMULARIO (Si no envían nada, por defecto se va a 'glow')
        const tiendaSeleccionada = req.body.tienda || 'glow';

        // 2. DESPUÉS creamos el producto con la URL y la tienda ya listas
        const nuevoProducto = new Producto({
            nombre: nombreFinal,      
            categoria: categoriaSeleccionada, 
            precioVenta: parseInt(req.body.precio || req.body.precioVenta || 0),
            costoCompra: parseFloat(req.body.costo || req.body.costoCompra || 0),
            cantidadStock: parseInt(req.body.stock || req.body.cantidadStock || 0),
            descuento: parseInt(req.body.descuento || req.body.descIndividual || 0),
            imagen: urlImagen, 
            foto: urlImagen,
            tienda: tiendaSeleccionada // <--- ¡AQUÍ GUARDAMOS A QUÉ TIENDA PERTENECE!
        });

        const guardado = await nuevoProducto.save();
        console.log("Producto guardado CON imagen en MongoDB:", guardado);

        res.json({ exito: true, mensaje: "¡Guardado con éxito!" });

    } catch (error) {
        console.error("Error en servidor:", error);
        res.status(500).json({ exito: false, mensaje: "Error interno" });
    }
});

// ==========================================
// RUTA 3: Procesar la compra, validar stock y registrar en panel
// ==========================================
app.post('/api/comprar', async (req, res) => {
    try {
        console.log("📥 RECIBIENDO PEDIDO NUEVO...");
        console.log("Datos recibidos (req.body):", req.body); // Para ver qué nos envía la web

        const { nombre, telefono, direccion, carrito } = req.body;

        // 1. BLINDAJE DEL CARRITO: Evitar el error de JSON.parse
        let productosComprados = [];
        if (typeof carrito === 'string') {
            productosComprados = JSON.parse(carrito); // Si viene como texto, lo convertimos
        } else if (Array.isArray(carrito)) {
            productosComprados = carrito; // Si ya viene como arreglo, lo dejamos igual
        } else {
            throw new Error("El formato del carrito no es reconocido.");
        }

        console.log("🛒 Productos detectados:", productosComprados.length);

        // 2. BLINDAJE DEL STOCK: Validar IDs antes de buscar en la BD
        for (const item of productosComprados) {
            const idBuscar = item._id || item.id;
            // Solo buscamos si el ID existe y tiene 24 caracteres (formato válido de MongoDB)
            if (idBuscar && String(idBuscar).length === 24) {
                const productoEnBD = await Producto.findById(idBuscar);
                if (productoEnBD) {
                    productoEnBD.cantidadStock = Math.max(0, productoEnBD.cantidadStock - (item.cantidad || 1));
                    await productoEnBD.save();
                }
            }
        }

        // 3. REGISTRAR EL PEDIDO EN MONGODB
        const nuevoPedido = new Pedido({
            idPedido: "PED-" + Date.now(),
            fecha: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
            cliente: nombre || 'Sin nombre',
            contacto: telefono || 'Sin teléfono',
            direccion: direccion || 'Sin dirección',
            productos: productosComprados,
            total: productosComprados.reduce((sum, p) => sum + (parseFloat(p.precioConDescuento || p.precioVenta || p.precio || 0) * (p.cantidad || 1)), 0),
            estado: 'PENDIENTE'
        });

        const guardado = await nuevoPedido.save();
        console.log("✅ Pedido guardado exitosamente con ID:", guardado.idPedido);

        res.json({ exito: true, mensaje: "¡Pedido registrado con éxito!", idPedido: guardado.idPedido });
    } catch (error) {
        // AQUÍ ATRAPAMOS EL ERROR REAL Y LO IMPRIMIMOS
        console.error("❌ ERROR CRÍTICO AL PROCESAR PEDIDO:", error.message);
        console.error(error);
        res.status(500).json({ exito: false, mensaje: "Error interno al procesar el pedido.", detalle: error.message });
    }
});

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
// // RUTA 5: Despachar un pedido asignando transportadora y guía en MongoDB Atlas
// ==========================================

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

// // RUTA 6: Entregar un pedido cambiando su estado final en MongoDB Atlas
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
// RUTA 7: Ver Factura Web / Enviar por WhatsApp
// ==========================================
app.get('/api/pedidos/:id/factura', async (req, res) => {
    try {
        const idBuscado = req.params.id; // Viene como string (ej. PED-1786...)
        
        // Buscamos directamente en MongoDB
        const pedido = await Pedido.findOne({ idPedido: idBuscado });

        if (!pedido) {
            return res.status(404).send(`
                <div style="font-family: Arial; text-align: center; margin-top: 50px;">
                    <h2 style="color: #e74c3c;">El pedido no existe</h2>
                    <p>Verifica que el enlace sea correcto.</p>
                </div>
            `);
        }

        // Blindamos las listas de productos por si vienen con otro nombre
        const listaProductos = pedido.productos || pedido.articulosDetallados || [];
        const telCliente = pedido.telefono || pedido.contacto || 'No registrado';

        const htmlFactura = `
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Factura de Venta #${pedido.idPedido}</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; padding: 20px; background-color: #f4f7f6; margin: 0; }
                .factura-box { max-width: 750px; margin: auto; padding: 30px; background: #fff; border: 1px solid #ddd; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
                .header-container { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #2c3e50; padding-bottom: 15px; }
                .columnas-datos { display: flex; justify-content: space-between; margin: 20px 0; gap: 15px; flex-wrap: wrap; }
                .columna { flex: 1; min-width: 250px; background: #f9f9f9; padding: 15px; border-radius: 6px; border-left: 4px solid #2c3e50; }
                table { width: 100%; border-collapse: collapse; margin-top: 15px; }
                th { background: #2c3e50; color: white; padding: 10px; font-size: 12px; text-align: left; }
                td { padding: 10px; border-bottom: 1px solid #eee; font-size: 13px; }
                .total-box { background: #2c3e50; color: white; padding: 15px; border-radius: 6px; text-align: right; margin-top: 20px; width: 260px; margin-left: auto; }
                .btn-imprimir { display: block; width: 100%; background: #27ae60; color: white; border: none; padding: 12px; border-radius: 6px; font-size: 15px; font-weight: bold; cursor: pointer; margin-top: 30px; text-align: center; text-decoration: none; }
                .btn-imprimir:hover { background: #219653; }
                @media print {
                    .btn-imprimir { display: none; }
                    body { background: white; padding: 0; }
                    .factura-box { border: none; box-shadow: none; padding: 0; }
                }
            </style>
        </head>
        <body>
        <div class="factura-box">
            <div class="header-container">
                <div>
                    <h2 style="margin:0; color:#2c3e50;">GLOW BY MAR</h2>
                    <p style="margin:5px 0 0 0; color:#7f8c8d; font-size:13px;">Accesorios y Joyería Premium</p>
                </div>
                <img src="https://cdn-icons-png.flaticon.com/512/3081/3081559.png" style="width:60px;">
            </div>

            <div class="columnas-datos">
                <div class="columna">
                    <h3 style="margin-top:0; color:#2c3e50; font-size:14px;">Datos del Cliente</h3>
                    <p style="margin:5px 0;"><strong>Nombre:</strong> ${pedido.cliente}</p>
                    <p style="margin:5px 0;"><strong>Teléfono:</strong> ${telCliente}</p>
                    <p style="margin:5px 0;"><strong>Dirección:</strong> ${pedido.direccion}</p>
                </div>
                <div class="columna">
                    <h3 style="margin-top:0; color:#2c3e50; font-size:14px;">Detalles de Venta</h3>
                    <p style="margin:5px 0;"><strong>Factura:</strong> #${pedido.idPedido}</p>
                    <p style="margin:5px 0;"><strong>Fecha:</strong> ${pedido.fecha}</p>
                    <p style="margin:5px 0;"><strong>Estado:</strong> <span style="color: #e67e22; font-weight:bold;">${pedido.estado || 'PENDIENTE'}</span></p>
                </div>
            </div>

            <table>
                <thead>
                    <tr>
                        <th>Artículo</th>
                        <th style="text-align:center;">Cant.</th>
                        <th style="text-align:right;">Precio Unit.</th>
                        <th style="text-align:right;">Subtotal</th>
                    </tr>
                </thead>
                <tbody>
                    ${listaProductos.map(art => {
                        const precioProd = parseFloat(art.precioConDescuento || art.precio || art.precioOriginal || 0);
                        const cantidadProd = parseInt(art.cantidad || 1);
                        const subtotalProd = precioProd * cantidadProd;
                        return `
                        <tr>
                            <td><strong>${art.nombre || 'Accesorio'}</strong></td>
                            <td style="text-align:center;">${cantidadProd}</td>
                            <td style="text-align:right;">$${precioProd.toLocaleString('es-CO')}</td>
                            <td style="text-align:right; font-weight:bold;">$${subtotalProd.toLocaleString('es-CO')}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>

            <div class="total-box">
                <p style="margin:0; font-size:12px; text-transform:uppercase;">Total Neto Pagado</p>
                <h2 style="margin:5px 0 0 0; color:#2ecc71;">$${parseInt(pedido.total || 0).toLocaleString('es-CO')} COP</h2>
            </div>

            <button class="btn-imprimir" onclick="window.print()">🖨️ Imprimir / Guardar como PDF</button>
        </div>
        </body>
        </html>`;

        res.send(htmlFactura);

    } catch (error) {
        console.error("Error al generar la factura:", error);
        res.status(500).send("<h1>Error al generar la factura en el servidor</h1>");
    }
});

// ==========================================
// RUTA 8: Reporte Mensual DETALLADO por Tienda (MongoDB)
// ==========================================
app.get('/api/reportes/mensual', async (req, res) => {
    try {
        const tiendaFiltro = (req.query.tienda || 'glow').toLowerCase();
        const nombreTiendaTexto = tiendaFiltro === 'glow' ? 'Glow' : 'VOLK';

        const pedidos = await Pedido.find({});
        if (!pedidos || pedidos.length === 0) return res.status(404).send("<h1>No hay datos de ventas aún en MongoDB</h1>");

        const productosBD = await Producto.find({});
        
        const resumenMeses = {};
        let granTotalCaja = 0;

        pedidos.forEach(p => {
            const listaArticulosOriginales = p.articulosDetallados || p.productos || [];
            
            const articulosFiltrados = listaArticulosOriginales.filter(art => {
                const nombreArt = art.nombre || art.titulo || "";
                const prodEnBD = productosBD.find(prod => prod.nombre.trim().toLowerCase() === nombreArt.trim().toLowerCase());
                const tiendaProd = prodEnBD && prodEnBD.tienda ? prodEnBD.tienda.toLowerCase() : 'glow';
                return tiendaProd === tiendaFiltro;
            });

            if (articulosFiltrados.length === 0) return;

            let mesAnio = 'General';
            if (p.fecha) {
                const partes = p.fecha.replace(/\s+/g, '').split('/');
                if (partes.length >= 3) mesAnio = partes[1] + '/' + partes[2].substring(0, 4);
            }

            if (!resumenMeses[mesAnio]) {
                resumenMeses[mesAnio] = { totalVentas: 0, cantidadPedidos: 0, listaDetallada: [] };
            }

            resumenMeses[mesAnio].cantidadPedidos += 1;

            articulosFiltrados.forEach(art => {
                const nombreArt = art.nombre || art.titulo || "Producto";
                const cantArt = art.cantidad || 1;
                const subArt = art.subtotal || (art.precioConDescuento * cantArt) || (art.precio * cantArt) || 0;

                granTotalCaja += subArt;
                resumenMeses[mesAnio].totalVentas += subArt;

                const prodEncontrado = productosBD.find(prod => prod.nombre.trim().toLowerCase() === nombreArt.trim().toLowerCase());
                const costoReal = prodEncontrado ? (prodEncontrado.costoCompra || prodEncontrado.costo || 0) : (art.costo || 0);

                const precioOrig = art.precioOriginal || art.precio || 0;
                const precioPromo = art.precioConDescuento || art.precioEfectivoUnidad || (subArt / cantArt);
                const gananciaReal = (precioPromo - costoReal) * cantArt;

                resumenMeses[mesAnio].listaDetallada.push({
                    nombre: nombreArt,
                    cantidad: cantArt,
                    costo: costoReal,
                    precioOriginal: precioOrig,
                    subtotal: subArt,
                    precioPromocion: precioPromo,
                    ganancia: gananciaReal,
                    obs: p.obs && p.obs.trim() !== "" ? p.obs : (p.direccion === "Tienda Física" ? "Venta Presencial" : "Venta Web")
                });
            });
        });

        if (Object.keys(resumenMeses).length === 0) {
            return res.status(404).send("<h1>No hay registros de ventas para la tienda: " + nombreTiendaTexto + "</h1>");
        }

        let bloquesHtml = "";

        Object.keys(resumenMeses).forEach(mes => {
            const datosMes = resumenMeses[mes];
            const lista = datosMes.listaDetallada;

            let sumaCosto = 0;
            let sumaPrecioOrig = 0;
            let sumaPrecioProm = 0;
            let sumaGanancia = 0;
            let sumaSubtotal = 0;

            let filasHtml = "";
            lista.forEach(art => {
                sumaCosto += (art.costo * art.cantidad || 0);
                sumaPrecioOrig += (art.precioOriginal * art.cantidad || 0);
                sumaPrecioProm += (art.precioPromocion || art.precioOriginal || 0);
                sumaGanancia += (art.ganancia || 0);
                sumaSubtotal += (art.subtotal || 0);

                filasHtml += `
                    <tr>
                        <td>${art.nombre}</td>
                        <td>${art.cantidad}</td>
                        <td>$${(art.costo || 0).toLocaleString('es-CO')}</td>
                        <td>$${(art.precioOriginal || 0).toLocaleString('es-CO')}</td>
                        <td>$${(art.precioPromocion || art.precioOriginal || 0).toLocaleString('es-CO')}</td>
                        <td>$${(art.ganancia || 0).toLocaleString('es-CO')}</td>
                        <td>$${(art.subtotal || 0).toLocaleString('es-CO')}</td>
                        <td><b>${art.obs || "Venta"}</b></td>
                    </tr>
                `;
            });

            bloquesHtml += `
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
                            ${filasHtml}
                            <tr style="font-weight: bold; background-color: #f8f9fa;">
                                <td colspan="2">TOTAL CICLO</td>
                                <td>$${sumaCosto.toLocaleString('es-CO')}</td>
                                <td>$${sumaPrecioOrig.toLocaleString('es-CO')}</td>
                                <td>$${sumaPrecioProm.toLocaleString('es-CO')}</td>
                                <td>$${sumaGanancia.toLocaleString('es-CO')}</td>
                                <td>$${sumaSubtotal.toLocaleString('es-CO')}</td>
                                <td>-</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            `;
        });

        const htmlReporte = `
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <title>Reporte Detallado - ${nombreTiendaTexto}</title>
                <style>
                    body { font-family: sans-serif; padding: 20px; background-color: #f4f6f9; color: #333; }
                    h1 { color: #2c3e50; }
                    .ciclo-bloque { margin-bottom: 30px; background: #fff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 20px; }
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                    th, td { border: 1px solid #e0e0e0; padding: 10px; text-align: left; }
                    th { background-color: #f8f9fa; color: #2c3e50; }
                </style>
            </head>
            <body>
                <h1>GLOW BY MAR (${nombreTiendaTexto.toUpperCase()}) - Reporte Detallado</h1>
                ${bloquesHtml}
                <h2>Total Histórico (${nombreTiendaTexto}): $${granTotalCaja.toLocaleString('es-CO')} COP</h2>
            </body>
            </html>
        `;

        res.send(htmlReporte);

    } catch (error) {
        console.error('Error en Ruta 8:', error);
        res.status(500).send("<h1>Error interno al generar el reporte desde MongoDB.</h1>");
    }
});

// ====================================================
// 🔥 RUTA 9: Editar un producto existente (MongoDB + Cloudinary)
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
            // Si hay archivo nuevo, lo mandamos a Cloudinary (Corregido: archivoSubido en singular)
            const resultadoCloudinary = await cloudinary.uploader.upload(archivoSubido.path, {
                folder: "glowbymar_tienda",
                transformation: [
                    { width: 800, crop: "limit" },
                    { quality: "auto", fetch_format: "auto" }
                ]
            });
            nuevaImagenUrl = resultadoCloudinary.secure_url; // 👈 ¡Actualizamos la URL con la nueva imagen de la nube!
        } // 👈 ¡Cerramos la llave del if correctamente!

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
// 🔥 RUTA 10: Registrar Venta (Web o Artículo Libre del Joyero)
// ==========================================
app.post('/api/registrar-venta', async (req, res) => {
    try {
        const { productoId, cantidad, tipoVenta, cliente, esArticuloLibre, nombreLibre, precioLibre, tienda } = req.body; 

        let itemVenta = {};
        let subtotal = 0;
        const tiendaPedido = tienda ? tienda.toLowerCase().trim() : 'glow';

        // 🟢 CASO 1: Es un artículo externo del joyero (fuera de la web)
        if (esArticuloLibre) {
            if (!nombreLibre || !precioLibre || !cantidad) {
                return res.status(400).json({ exito: false, mensaje: 'Faltan datos del artículo libre.' });
            }

            const precioNum = Number(precioLibre);
            const cantNum = Number(cantidad);
            subtotal = precioNum * cantNum;

            itemVenta = {
                nombre: `${nombreLibre} (Joyero)`,
                cantidad: cantNum,
                costo: req.body.costoLibre || 0,
                precioOriginal: precioNum,
                precioConDescuento: precioNum,
                subtotal: subtotal
            };

        } else {
            // 🔵 CASO 2: Producto de la base de datos buscado por su ID único
            if (!productoId || !cantidad) {
                return res.status(400).json({ exito: false, mensaje: 'Faltan datos del producto.' });
            }

            const prodBD = await Producto.findById(productoId);

            if (!prodBD) {
                return res.status(400).json({ exito: false, mensaje: 'El producto no existe en el inventario.' });
            }

            const stockActual = Number(
                prodBD.cantidadStock !== undefined ? prodBD.cantidadStock : 
                (prodBD.stock !== undefined ? prodBD.stock : 0)
            );

            if (stockActual < Number(cantidad)) {
                return res.status(400).json({ exito: false, mensaje: `Stock insuficiente. Solo quedan ${stockActual} unidades.` });
            }

            const precioOriginal = prodBD.precioVenta || prodBD.precio || 0;
            const costo = prodBD.costoCompra || prodBD.costo || 0;
            const descuento = prodBD.descuento || prodBD.descIndividual || prodBD.descuentoIndividual || 0;
            const precioEfectivo = descuento > 0 ? precioOriginal - (precioOriginal * (descuento / 100)) : precioOriginal;
            subtotal = precioEfectivo * Number(cantidad);

            // Descontar stock en MongoDB
            prodBD.cantidadStock = stockActual - Number(cantidad);
            if (prodBD.stock !== undefined) {
                prodBD.stock = prodBD.cantidadStock;
            }
            await prodBD.save();

            itemVenta = {
                nombre: prodBD.nombre,
                cantidad: Number(cantidad),
                costo: costo,
                precioOriginal: precioOriginal,
                precioConDescuento: precioEfectivo,
                subtotal: subtotal
            };
        }

        // Lógica unificada de guardado del pedido asignando su respectiva tienda
        const ultimoPedido = await Pedido.findOne().sort({ idPedido: -1 });
        const nuevoIdNum = ultimoPedido && typeof ultimoPedido.idPedido === 'number' ? ultimoPedido.idPedido + 1 : 1;

        const nuevoPedido = new Pedido({
            idPedido: nuevoIdNum,
            fecha: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
            obs: tipoVenta || "Venta Presencial", 
            cliente: cliente || "Cliente Presencial",
            telefono: "N/A",
            direccion: "Tienda Física",
            total: subtotal,
            estado: 'ENTREGADO', 
            tienda: tiendaPedido, // 👈 Guardamos la tienda en el pedido para que llegue a su reporte correcto
            productos: [itemVenta],
            articulosDetallados: [itemVenta],
            articulos: [`${itemVenta.nombre} (x${cantidad})`]
        });

        await nuevoPedido.save();

        return res.status(200).json({ exito: true, mensaje: '¡Venta registrada y finalizada con éxito!' });

    } catch (error) {
        console.error('Error en Ruta 10:', error);
        return res.status(500).json({ exito: false, mensaje: 'Error interno en el servidor.' });
    }
});


// ==========================================
// RUTA 11: Traer todos los pedidos de MongoDB
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


// ==========================================
// RUTA 12 OFERTAS MASIVAS POR TIENDA
// ==========================================

// 1. Activar ofertas masivas (Global o por Categoría) para una tienda específica
app.post('/api/ofertas/activar', async (req, res) => {
    try {
        const { tipo, porcentaje, categoria, tienda = 'glow' } = req.body;
        const porc = Number(porcentaje) || 0;

        // Filtramos estrictamente por la tienda seleccionada (glow o volk)
        let filtro = { tienda: tienda.toLowerCase() };
        
        // Si el tipo es por categoría específica
        if (tipo === 'categoria' && categoria) {
            filtro.categoria = categoria;
        }

        // Actualizamos los productos directamente en MongoDB
        const resultado = await Producto.updateMany(filtro, { 
            $set: { descuento: porc } 
        });

        res.json({ 
            exito: true, 
            mensaje: `Ofertas aplicadas exitosamente a la tienda ${tienda}`,
            modificados: resultado.modifiedCount 
        });
    } catch (error) {
        console.error("Error al activar ofertas:", error);
        res.status(500).json({ exito: false, mensaje: "Error del servidor al activar ofertas" });
    }
});

// 2. Apagar/Remover ofertas de una tienda específica
app.post('/api/ofertas/desactivar', async (req, res) => {
    try {
        const { tienda } = req.body;
        
        // Filtramos por la tienda o aplicamos a todas si no viene especificada
        let filtro = tienda ? { tienda: tienda.toLowerCase() } : {};

        // Limpiamos ambos campos de descuento para dejar los precios normales
        const resultado = await Producto.updateMany(filtro, { 
            $set: { 
                descuento: 0, 
                descIndividual: 0 
            } 
        });

        res.json({ 
            exito: true, 
            mensaje: "Ofertas removidas exitosamente",
            modificados: resultado.modifiedCount 
        });
    } catch (error) {
        console.error("Error al desactivar ofertas:", error);
        res.status(500).json({ exito: false, mensaje: "Error del servidor al desactivar ofertas" });
    }
});

app.get('/api/ofertas/estado', async (req, res) => {
    try {
        // Puedes consultar si hay algún producto con descuento activo
        const ofertasActivas = await Producto.countDocuments({ descuento: { $gt: 0 } });
        res.json({ hayOfertas: ofertasActivas > 0 });
    } catch (error) {
        res.status(500).json({ hayOfertas: false });
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