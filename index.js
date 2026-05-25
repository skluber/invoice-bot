import { Telegraf, Scenes, session } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import PDFDocument from 'pdfkit';
import 'dotenv/config';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// ESCENA PRINCIPAL DE FACTURACIÓN
const nuevaFacturaEscena = new Scenes.WizardScene(
  'NUEVA_FACTURA_SCENE',
  
  // PASO 1 (Índice 0): Buscador de Cliente (Pedir texto)
  async (ctx) => {
    ctx.wizard.state.factura = { conceptos: [] };
    await ctx.reply('🔍 Escribe el nombre de la clínica (o parte de él) para buscarla en la base de datos:');
    return ctx.wizard.next();
  },

  // PASO 2 (Índice 1): Procesar búsqueda y mostrar resultados filtrados (Control de franquicias)
  async (ctx) => {
    const busqueda = ctx.message?.text;
    if (!busqueda) return ctx.reply('Por favor, introduce un texto para buscar.');

    const { data: clientes, error } = await supabase
      .from('clientes')
      .select('*')
      .ilike('nombre_clinica', `%${busqueda}%`);

    if (error || !clientes || clientes.length === 0) {
      await ctx.reply('❌ No se encontró ninguna clínica con ese nombre. Escríbelo de nuevo para buscar:');
      return; 
    }

    if (clientes.length === 1) {
      ctx.wizard.state.factura.cliente = clientes[0];
      await ctx.reply(`✅ Cliente seleccionado: *${clientes[0].nombre_clinica}* (${clientes[0].direccion.split(',')[0]})`, { parse_mode: 'Markdown' });
      return mostrarMenuConceptos(ctx);
    }

    ctx.wizard.state.listaClientesFiltrados = clientes;
    
    const botones = clientes.map(c => {
      const calleCorta = c.direccion ? c.direccion.split(',')[0].substring(0, 20) : 'Sin dirección';
      return [{ text: `${c.nombre_clinica} (${calleCorta})`, callback_data: `cli_${c.id}` }];
    });

    await ctx.reply('👥 He encontrado varias coincidencias con ese nombre.\nSelecciona la franquicia correcta según su calle:', {
      reply_markup: { inline_keyboard: botones }
    });
    return ctx.wizard.next();
  },

  // PASO 3 (Índice 2): Capturar cliente seleccionado por botón (solo si hubo múltiples)
  async (ctx) => {
    if (!ctx.callbackQuery) return ctx.reply('Selecciona un cliente de la lista.');
    const clienteId = parseInt(ctx.callbackQuery.data.replace('cli_', ''));
    ctx.wizard.state.factura.cliente = ctx.wizard.state.listaClientesFiltrados.find(c => c.id === clienteId);
    await ctx.answerCbQuery();
    
    return mostrarMenuConceptos(ctx);
  },

  // PASO 4 (Índice 3): Procesar la acción del menú central
  async (ctx) => {
    if (!ctx.callbackQuery) return ctx.reply('Por favor, selecciona una opción del menú.');
    const accion = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (accion === 'menu_descartar') {
      await ctx.reply('🗑️ Proceso cancelado. La factura ha sido descartada por completo.');
      return ctx.scene.leave(); 
    }

    ctx.wizard.state.accionActual = accion;

    switch (accion) {
      case 'menu_reparacion':
        await ctx.reply('🔧 ¿Qué reparación has realizado?');
        break;
      case 'menu_recambio':
        await ctx.reply('🔩 Escribe el nombre de la pieza de recambio:');
        break;
      case 'menu_mano_obra':
        await ctx.reply('⏱️ Precio por hora de mano de obra:');
        break;
      case 'menu_desplazamiento':
        await ctx.reply('🚗 Introduce el coste total del desplazamiento:');
        break;
      case 'menu_finalizar':
        return mostrarResumenRevision(ctx);
    }
    return ctx.wizard.next(); 
  },

  // PASO 5 (Índice 4): [NÚCLEO CAPTURA DE DATOS] - Captura textos y redirige precios
  async (ctx) => {
    const text = ctx.message?.text;
    const accion = ctx.wizard.state.accionActual;

    if (!text) return ctx.reply('Por favor, introduce el dato solicitado.');

    if (accion === 'menu_reparacion') {
      ctx.wizard.state.tempConcepto = text;
      await ctx.reply(`💶 ¿Cuál es el COSTE de la reparación: "${text}"?`);
      ctx.wizard.state.accionActual = 'menu_reparacion_precio';
      return; 
    } 
    
    if (accion === 'menu_reparacion_precio') {
      const coste = parseFloat(text.replace(',', '.'));
      if (isNaN(coste)) return ctx.reply('❌ Introduce un número válido.');
      
      guardarEnCarrito(ctx, 'REP', ctx.wizard.state.tempConcepto, 1, coste);
      return mostrarMenuConceptos(ctx);
    }

    if (accion === 'menu_recambio') {
      ctx.wizard.state.tempConcepto = text;
      await ctx.reply(`🔢 Introduce el NÚMERO DE SERIE del producto\n(o escribe "S/N" si no tiene):`);
      ctx.wizard.state.accionActual = 'menu_recambio_sn';
      return;
    }

    if (accion === 'menu_recambio_sn') {
      ctx.wizard.state.tempSN = text;
      await ctx.reply(`💶 ¿Cuál es el COSTE UNITARIO de este recambio?`);
      ctx.wizard.state.accionActual = 'menu_recambio_precio';
      return;
    }

    if (accion === 'menu_recambio_precio') {
      const coste = parseFloat(text.replace(',', '.'));
      if (isNaN(coste)) return ctx.reply('❌ Introduce un precio válido.');
      
      const conceptoCompleto = `${ctx.wizard.state.tempConcepto} (S/N: ${ctx.wizard.state.tempSN})`;
      guardarEnCarrito(ctx, 'REP', conceptoCompleto, 1, coste);
      return mostrarMenuConceptos(ctx);
    }

    if (accion === 'menu_mano_obra') {
      const precioHora = parseFloat(text.replace(',', '.'));
      if (isNaN(precioHora)) return ctx.reply('❌ Introduce un precio válido.');
      ctx.wizard.state.tempPrecio = precioHora;
      
      await ctx.reply('🔢 ¿Cuántas HORAS has dedicado?');
      ctx.wizard.state.accionActual = 'menu_mano_obra_horas';
      return;
    }

    if (accion === 'menu_mano_obra_horas') {
      const horas = parseFloat(text.replace(',', '.'));
      if (isNaN(horas)) return ctx.reply('❌ Introduce un número de horas válido.');
      
      guardarEnCarrito(ctx, 'SAT', 'MANO DE OBRA SAT (Horas)', horas, ctx.wizard.state.tempPrecio);
      return mostrarMenuConceptos(ctx);
    }

    if (accion === 'menu_desplazamiento') {
      const coste = parseFloat(text.replace(',', '.'));
      if (isNaN(coste)) return ctx.reply('❌ Introduce un coste válido.');
      
      guardarEnCarrito(ctx, 'DES', 'DESPLAZAMIENTO CIUDAD', 1, coste);
      return mostrarMenuConceptos(ctx);
    }
  },

  // PASO 6 (Índice 5): [PANTALLA DE REVISIÓN FINAL] - Decidir si emitir o eliminar algo
  async (ctx) => {
    if (ctx.callbackQuery) {
      const accion = ctx.callbackQuery.data;
      await ctx.answerCbQuery();

      if (accion === 'factura_confirmar') {
        if (ctx.wizard.state.factura.conceptos.length === 0) {
          await ctx.reply('❌ No puedes generar una factura vacía.');
          return mostrarMenuConceptos(ctx);
        }
        await generarFacturaClonada(ctx);
        return ctx.scene.leave();
      }

      if (accion === 'factura_eliminar') {
        await ctx.reply('🗑️ Escribe el NÚMERO del elemento de la lista que deseas borrar:');
        return; 
      }
      
      if (accion === 'factura_volver') {
        return mostrarMenuConceptos(ctx);
      }

      if (accion === 'factura_descartar') {
        await ctx.reply('🗑️ Proceso cancelado. La factura ha sido descartada por completo.');
        return ctx.scene.leave();
      }
    }

    const indiceBorrar = parseInt(ctx.message?.text) - 1;
    const conceptos = ctx.wizard.state.factura.conceptos;

    if (isNaN(indiceBorrar) || indiceBorrar < 0 || indiceBorrar >= conceptos.length) {
      await ctx.reply('❌ Número inválido. Pon un número que aparezca en la lista:');
      return;
    }

    const eliminado = conceptos.splice(indiceBorrar, 1);
    await ctx.reply(`🗑️ Eliminado de la lista: "${eliminado[0].concepto}"`);
    
    return mostrarResumenRevision(ctx);
  }
);

// --- 🛠️ FUNCIONES AUXILIARES ---

function guardarEnCarrito(ctx, codigo, concepto, cantidad, precioUnitario) {
  ctx.wizard.state.factura.conceptos.push({
    codigo,
    concepto,
    cantidad,
    precio_unitario: precioUnitario,
    total_linea: precioUnitario * cantidad
  });
}

async function mostrarMenuConceptos(ctx) {
  const numElementos = ctx.wizard.state.factura.conceptos.length;
  await ctx.reply(`📑 *MENÚ GENERAL FACTURA* \n(Líneas añadidas actualmente: ${numElementos})\n\nSelecciona qué elemento deseas incorporar:`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔧  Añadir Reparación', callback_data: 'menu_reparacion' }],
        [{ text: '🔩  Añadir Recambio', callback_data: 'menu_recambio' }],
        [{ text: '⏱️  Añadir Mano de Obra', callback_data: 'menu_mano_obra' }],
        [{ text: '🚗  Añadir Desplazamiento', callback_data: 'menu_desplazamiento' }],
        [{ text: '🏁  Finalizar factura', callback_data: 'menu_finalizar' }],
        [{ text: '❌  Descartar factura', callback_data: 'menu_descartar' }]
      ]
    }
  });
  return ctx.wizard.selectStep(3); 
}

async function mostrarResumenRevision(ctx) {
  const conceptos = ctx.wizard.state.factura.conceptos;
  let mensaje = `📋 *RESUMEN DE REVISIÓN DE LA FACTURA*\n\n`;

  if (conceptos.length === 0) {
    mensaje += `_(La lista está vacía actualmente)_\n`;
  } else {
    conceptos.forEach((c, index) => {
      mensaje += `*${index + 1}.* [${c.codigo}] ${c.concepto}\n      _${c.cantidad} ud x ${c.precio_unitario.toFixed(2)}€ = ${c.total_linea.toFixed(2)}€_\n\n`;
    });
  }

  mensaje += `¿Está todo correcto para emitir el PDF o quieres modificar algo?`;

  await ctx.reply(mensaje, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Todo perfecto, emitir PDF', callback_data: 'factura_confirmar' }],
        [{ text: '❌ Eliminar un elemento de la lista', callback_data: 'factura_eliminar' }],
        [{ text: '➕ Volver al menú para añadir más', callback_data: 'factura_volver' }],
        [{ text: '🚨 Cancelar y descartar Factura', callback_data: 'factura_descartar' }]
      ]
    }
  });
  return ctx.wizard.selectStep(5); 
}

// --- 📄 GENERADOR GRÁFICO SEGURO ---
async function generarFacturaClonada(ctx) {
  await ctx.reply('⏳ Generando factura oficial...');
  const { cliente, conceptos } = ctx.wizard.state.factura;
  const anioActual = new Date().getFullYear();

  // 1. Obtención del correlativo (Como acordamos)
  const { data: ultimasFacturas } = await supabase
    .from('facturas')
    .select('numero_factura')
    .gte('created_at', `${anioActual}-01-01T00:00:00Z`)
    .order('numero_factura', { ascending: false })
    .limit(1);

  let siguienteNumero = (ultimasFacturas && ultimasFacturas.length > 0) ? parseInt(ultimasFacturas[0].numero_factura) + 1 : 1;
  const numFactura = `${siguienteNumero.toString().padStart(3, '0')}/${anioActual}`;

  const subtotal = conceptos.reduce((acc, c) => acc + c.total_linea, 0);
  const iva = subtotal * 0.21;
  const total = subtotal + iva;

  // 2. GENERACIÓN DEL PDF CON ESTRUCTURA COMPLETA
  const pdfBuffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 45, size: 'A4' });
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // --- ENCABEZADO ---
    doc.image('logo.png', 45, 50, { width: 65 });
      // Si el logo está a la izquierda, desplazamos el texto para que no se solape
      doc.fontSize(20).font('Helvetica-Bold').text('Tecno-dent', 120, 50);
      doc.fontSize(10).font('Helvetica').text('ANTONIO RODRÍGUEZ ZAMORA', 120, 80);
      doc.text('C/ OLIMPO 5, 2º1 | CÓRDOBA | C.P. 14014', 120, 95);
      doc.text('TEL: 629 16 37 38 | NIF: 30.496.884-B', 120, 110);

    // --- INFO FACTURA ---
    doc.font('Helvetica-Bold').text('N° DE FACTURA:', 350, 50);
    doc.font('Helvetica').text(numFactura, 450, 50);
    doc.font('Helvetica-Bold').text('FECHA:', 350, 65);
    doc.font('Helvetica').text(new Date().toLocaleDateString('es-ES'), 450, 65);

    // --- CLIENTE ---
    doc.font('Helvetica-Bold').text('CLIENTE:', 45, 150);
    doc.font('Helvetica').text(cliente.nombre_clinica, 45, 165);
    doc.text(cliente.direccion || '', 45, 180);

    // --- TABLA CONCEPTOS ---
    let y = 230;
    // Cabecera de la tabla
    doc.rect(45, y, 500, 20).fill('#f0f0f0');
    doc.fillColor('black').font('Helvetica-Bold').fontSize(9);
    doc.text('CÓDIGO', 50, y + 6);
    doc.text('DESCRIPCIÓN', 120, y + 6);
    doc.text('CANT.', 350, y + 6, { width: 40, align: 'right' });
    doc.text('PRECIO', 400, y + 6, { width: 60, align: 'right' });
    doc.text('TOTAL', 470, y + 6, { width: 70, align: 'right' });

    y += 30;
    doc.font('Helvetica').fillColor('#2d3748');
    
    conceptos.forEach(c => {
      // Dibujamos cada columna alineada con los encabezados
      doc.text(c.codigo, 50, y);
      doc.text(c.concepto, 120, y, { width: 220 });
      doc.text(c.cantidad.toString(), 350, y, { width: 40, align: 'right' });
      doc.text(c.precio_unitario.toFixed(2).replace('.', ','), 400, y, { width: 60, align: 'right' });
      doc.text(c.total_linea.toFixed(2).replace('.', ','), 470, y, { width: 70, align: 'right' });
      
      // Calculamos altura para saltos de línea dinámicos si la descripción es larga
      const height = doc.heightOfString(c.concepto, { width: 220 });
      y += Math.max(20, height + 5);
    });

    // --- TOTALES ---
    y += 20;
    doc.moveTo(400, y).lineTo(550, y).stroke();
    y += 10;
    doc.fontSize(9).text('BASE IMPONIBLE', 400, y); doc.text(subtotal.toFixed(2) + ' €', 500, y);
    y += 15;
    doc.text('IVA 21%', 400, y); doc.text(iva.toFixed(2) + ' €', 500, y);
    doc.font('Helvetica-Bold').text('TOTAL EUROS', 400, y + 20); 
    doc.text(total.toFixed(2) + ' €', 500, y + 20);

    // --- PIE DE PÁGINA (Añadido email y cuenta bancaria) ---
    doc.fontSize(8.5).font('Helvetica').text(
      'tecno-dent@hotmail.com | PAGO POR TRANSFERENCIA Nº CUENTA: ES90 2100 3949 4401 0021 5400', 
      45, 750, 
      { align: 'center', width: 500 }
    );

    doc.end(); // ¡ESENCIAL!
  });

  // 3. GUARDADO
  const { error: errorInsert } = await supabase.from('facturas').insert([{ 
    numero_factura: siguienteNumero, cliente_id: cliente.id, subtotal, iva, total, pagada: false, created_at: new Date().toISOString() 
  }]);

  if (errorInsert) return ctx.reply('Error: ' + errorInsert.message);

  await ctx.replyWithDocument({ source: pdfBuffer, filename: `Factura_${numFactura.replace('/', '_')}.pdf` });
}
// INICIALIZACIÓN
const stage = new Scenes.Stage([nuevaFacturaEscena]);
bot.use(session());
bot.use(stage.middleware());

bot.start(async (ctx) => {
  await ctx.reply('🔧 *Tecno-dent Facturación v5.5.*\nElige una gestión desde el menú inferior:', {
    parse_mode: 'Markdown',
    reply_markup: { 
      keyboard: [
        [{ text: '➕ Nueva factura' }, { text: '📊 Facturas pendientes' }]
      ], 
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
});

bot.hears('➕ Nueva factura', (ctx) => ctx.scene.enter('NUEVA_FACTURA_SCENE'));

// FUNCIÓN GENERAL: CONSULTAR PENDIENTES CON BOTONES DE COBRO INDEPENDIENTES
const consultarPendientesFuncion = async (ctx) => {
  await ctx.reply('🔍 Buscando facturas sin pagar en la base de datos...');

  const { data: facturas, error } = await supabase
    .from('facturas')
    .select(`
      id,
      numero_factura,
      total,
      cliente_id,
      clientes ( nombre_clinica, direccion )
    `)
    .eq('pagada', false);

  if (error) {
    console.error(error);
    return ctx.reply('❌ Error al conectar con la base de datos.');
  }

  if (!facturas || facturas.length === 0) {
    return ctx.reply('✅ ¡Excelente! No hay ninguna factura pendiente de pago actualmente.');
  }

  // Agrupación por clínica
  const clinicasPendientes = {};
  let sumaTotalGeneral = 0;

  facturas.forEach((f) => {
    const nombre = f.clientes?.nombre_clinica || 'Cliente Desconocido';
    const calleCorta = f.clientes?.direccion ? f.clientes.direccion.split(',')[0] : 'Sin dirección';
    const claveClinica = `${nombre} (${calleCorta})`;

    if (!clinicasPendientes[claveClinica]) {
      clinicasPendientes[claveClinica] = {
        clienteId: f.cliente_id, 
        facturas: [],
        subtotalClinica: 0
      };
    }

    clinicasPendientes[claveClinica].facturas.push({
      id: f.id,
      numero: f.numero_factura,
      importe: f.total
    });
    
    clinicasPendientes[claveClinica].subtotalClinica += f.total;
    sumaTotalGeneral += f.total;
  });

  await ctx.reply('⚠️ *FACTURAS PENDIENTES DE PAGO* ⚠️', { parse_mode: 'Markdown' });

  for (const [nombreClinica, info] of Object.entries(clinicasPendientes)) {
    let respuesta = `🏢 *${nombreClinica}*\n`;
    let botonesFila = [];
    
    info.facturas.forEach(fact => {
      respuesta += `  ▪️ Fct: \`${fact.numero}\` ➡️ *${fact.importe.toFixed(2).replace('.', ',')} €*\n`;
      botonesFila.push([{ text: `✅ Cobrada Fct: ${fact.numero}`, callback_data: `pagar_${fact.id}_${info.clienteId}` }]);
    });
    
    if (info.facturas.length > 1) {
      respuesta += `  💰 _Total clínica: ${info.subtotalClinica.toFixed(2).replace('.', ',')} €_\n`;
    }

    await ctx.reply(respuesta, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: botonesFila }
    });
  }

  await ctx.reply(`--- \n📉 *Total general pendiente:* _${sumaTotalGeneral.toFixed(2).replace('.', ',')} €_`, { parse_mode: 'Markdown' });
};

// MANEJADOR ACTUALIZADO: RE-CALCULA EN TIEMPO REAL LAS FACTURAS QUE QUEDAN
// REEMPLAZA TU BOT.ACTION POR ESTE DE AQUÍ:
bot.action(/^pagar_(\d+)_(\d+)$/, async (ctx) => {
  const facturaId = ctx.match[1];
  const clienteId = ctx.match[2];

  // 1. Marcamos la factura actual como pagada en Supabase
  const { error: updateError } = await supabase
    .from('facturas')
    .update({ pagada: true })
    .eq('id', facturaId);

  if (updateError) {
    console.error(updateError);
    return ctx.answerCbQuery('❌ No se pudo actualizar en la base de datos.', { show_alert: true });
  }

  await ctx.answerCbQuery('💰 ¡Factura cobrada!');

  // 2. Buscamos si quedan más facturas sin pagar de este cliente
  const { data: facturasRestantes, error: queryError } = await supabase
    .from('facturas')
    .select(`
      id,
      numero_factura,
      total,
      clientes ( nombre_clinica, direccion )
    `)
    .eq('cliente_id', clienteId)
    .eq('pagada', false);

  if (queryError) {
    console.error(queryError);
    return ctx.editMessageText('⚠️ Error al actualizar la lista.');
  }

  // 3. Si ya NO quedan facturas pendientes, mensaje limpio de todo pagado
  if (!facturasRestantes || facturasRestantes.length === 0) {
    // Intentamos rescatar el nombre de la clínica del mensaje anterior de forma limpia
    const textoAnterior = ctx.callbackQuery.message.text || '';
    const primeraLinea = textoAnterior.split('\n')[0] || '🏢 Clínica';
    
    return ctx.editMessageText(`${primeraLinea}\n\n🟢 *¡ESTA CLÍNICA YA HA PAGADO TODO!*`, { 
      parse_mode: 'Markdown' 
    });
  }

  // 4. Si AÚN quedan facturas, reconstruimos el texto desde cero (sin heredar nada del anterior)
  const primerRegistro = facturasRestantes[0];
  const nombre = primerRegistro.clientes?.nombre_clinica || 'Cliente Desconocido';
  const calleCorta = primerRegistro.clientes?.direccion ? primerRegistro.clientes.direccion.split(',')[0] : 'Sin dirección';

  // Usamos saltos de línea limpios explicados en una sola variable moldeada
  let linea1 = `🏢 *${nombre}*`;
  let linea2 = `_(${calleCorta})_`;
  let cuerpoFacturas = '';
  let nuevoSubtotal = 0;

  facturasRestantes.forEach(fact => {
    cuerpoFacturas += `\n  ▪️ Fct: \`${fact.numero_factura}\` ➡️ *${fact.total.toFixed(2).replace('.', ',')} €*`;
    nuevoSubtotal += fact.total;
  });

  let mensajeFinal = `${linea1}\n${linea2}\n${cuerpoFacturas}`;

  if (facturasRestantes.length > 1) {
    mensajeFinal += `\n\n  💰 _Total clínica: ${nuevoSubtotal.toFixed(2).replace('.', ',')} €_`;
  }

  let nuevosBotones = facturasRestantes.map(fact => {
    return [{ text: `✅ Cobrada Fct: ${fact.numero_factura}`, callback_data: `pagar_${fact.id}_${clienteId}` }];
  });

  // 5. Aplicamos la edición asegurando HTML para evitar los fallos de herencia de Markdown
  await ctx.editMessageText(mensajeFinal, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: nuevosBotones }
  });
});

bot.hears('📊 Facturas pendientes', consultarPendientesFuncion);
bot.hears(/^[pP]endientes$/, consultarPendientesFuncion);

bot.launch().then(() => console.log('🤖 Actualización dinámica de facturas activada.'));