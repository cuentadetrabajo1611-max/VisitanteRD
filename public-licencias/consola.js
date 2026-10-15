/* ============================================================================
   VisitaFlow - Consola del servidor de licencias

   Esta consola la usa el PROVEEDOR del software, no las instituciones. Su
   trabajo es dar de alta clientes y emitir su licencia firmada.

   Detalle importante: aqui NUNCA se ven los datos de las instituciones (ni
   visitantes, ni cédulas, ni visitas). El servidor de licencias solo sabe quien
   es el cliente, hasta cuando tiene derecho a operar y que modulos incluye su
   licencia. Esa separacion es lo que permite que cada institucion funcione sin
   Internet y sin exponer informacion personal.
   ============================================================================ */

(function () {
  'use strict';

  var app = document.getElementById('app');
  var token = null;

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function el(etiqueta, atributos, hijos) {
    var n = document.createElement(etiqueta);
    Object.keys(atributos || {}).forEach(function (k) {
      var v = atributos[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'clase') n.className = v;
      else if (k === 'texto') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    (Array.isArray(hijos) ? hijos : hijos ? [hijos] : []).forEach(function (h) {
      if (h === null || h === undefined || h === false) return;
      n.appendChild(typeof h === 'string' ? document.createTextNode(h) : h);
    });
    return n;
  }

  function aviso(tipo, titulo, texto, ms) {
    var cont = document.getElementById('avisos');
    var iconos = { exito: '✓', peligro: '!', aviso: '!', info: 'i' };
    var n = el('div', { clase: 'flotante flotante--' + (tipo || 'info') }, [
      el('span', { clase: 'flotante__icono', texto: iconos[tipo] || 'i' }),
      el('div', { clase: 'crecer' }, [
        titulo ? el('strong', { texto: titulo }) : null,
        texto ? el('div', { clase: 'texto-chico', texto: texto }) : null,
      ]),
      el('button', { clase: 'flotante__cerrar', texto: '×', 'aria-label': 'Cerrar', onClick: function () { n.remove(); } }),
    ]);
    cont.appendChild(n);
    setTimeout(function () { n.remove(); }, ms || (tipo === 'peligro' ? 9000 : 5000));
  }

  /** Fecha legible. */
  function fecha(v, conHora) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    var f = d.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' });
    if (!conHora) return f;
    return f + ' ' + d.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' });
  }

  /* ------------------------------------------------------------------ */
  /* Llamadas a la API                                                   */
  /* ------------------------------------------------------------------ */

  function pedir(metodo, ruta, cuerpo) {
    var cabeceras = { 'Content-Type': 'application/json' };
    if (token) cabeceras.Authorization = 'Bearer ' + token;

    return fetch(ruta, {
      method: metodo,
      headers: cabeceras,
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    }).then(function (r) {
      return r.text().then(function (texto) {
        var datos;
        try { datos = JSON.parse(texto); } catch (e) { datos = { mensaje: texto.slice(0, 200) }; }
        if (!r.ok) {
          var err = new Error((datos && datos.mensaje) || 'Error ' + r.status);
          err.estado = r.status;
          throw err;
        }
        return datos;
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Pantalla de entrada                                                 */
  /* ------------------------------------------------------------------ */

  function pantallaToken(mensaje) {
    app.innerHTML = '';

    var caja = el('div', { clase: 'acceso' }, [
      el('div', { clase: 'acceso__caja' }, [
        el('div', { clase: 'acceso__marca' }, [
          el('div', { clase: 'acceso__logo', texto: '🔑' }),
          el('h1', { clase: 'acceso__titulo', texto: 'Servidor de licencias' }),
          el('div', { clase: 'acceso__sub', texto: 'VisitaFlow' }),
        ]),
        el('div', { clase: 'tarjeta' }, [
          el('div', { clase: 'tarjeta__cuerpo' }, [
            mensaje ? el('div', { clase: 'aviso aviso--peligro', html: '<div>' + esc(mensaje) + '</div>' }) : null,
            el('div', { clase: 'campo' }, [
              el('label', { clase: 'campo__etiqueta', for: 'tk', texto: 'Token de administración' }),
              el('input', { clase: 'entrada entrada--mono', type: 'password', id: 'tk', autofocus: true, placeholder: 'ADMIN_TOKEN' }),
              el('div', { clase: 'campo__ayuda', texto: 'Es el valor de ADMIN_TOKEN configurado en el servidor.' }),
            ]),
            el('button', { clase: 'boton boton--bloque boton--grande', id: 'entrar', texto: 'Entrar' }),
          ]),
        ]),
        el('div', { clase: 'acceso__pie', texto: 'Este servidor no guarda datos de visitantes.' }),
      ]),
    ]);

    app.appendChild(caja);

    var campo = document.getElementById('tk');
    function entrar() {
      var v = campo.value.trim();
      if (!v) { campo.focus(); return; }
      token = v;
      try { sessionStorage.setItem('vf_admin_token', v); } catch (e) { /* modo privado */ }
      cargar();
    }
    document.getElementById('entrar').addEventListener('click', entrar);
    campo.addEventListener('keydown', function (e) { if (e.key === 'Enter') entrar(); });
  }

  /* ------------------------------------------------------------------ */
  /* Pantalla principal                                                  */
  /* ------------------------------------------------------------------ */

  var estado = { licencias: [], modulos: [], keyId: null, filtro: '' };

  function cargar() {
    app.innerHTML = '<div class="cargando"><div class="girador"></div><span>Cargando…</span></div>';

    Promise.all([pedir('GET', '/api/salud'), pedir('GET', '/api/admin/licencias')])
      .then(function (r) {
        estado.modulos = r[0].modulos || [];
        estado.keyId = r[0].llave ? r[0].llave.key_id : null;
        estado.licencias = r[1].licencias || [];
        pintar();
      })
      .catch(function (e) {
        if (e.estado === 401 || e.estado === 503) {
          token = null;
          try { sessionStorage.removeItem('vf_admin_token'); } catch (e2) {}
          pantallaToken(e.message);
        } else {
          app.innerHTML = '';
          app.appendChild(el('div', { clase: 'acceso' }, [
            el('div', { clase: 'acceso__caja' }, [
              el('div', { clase: 'aviso aviso--peligro', html: '<div><strong>No se pudo cargar</strong><div>' + esc(e.message) + '</div></div>' }),
              el('button', { clase: 'boton boton--bloque', texto: 'Reintentar', onClick: cargar }),
            ]),
          ]));
        }
      });
  }

  function pintar() {
    var lista = estado.licencias.filter(function (l) {
      if (!estado.filtro) return true;
      var f = estado.filtro.toLowerCase();
      return (l.tenant || '').indexOf(f) !== -1 || (l.cliente || '').toLowerCase().indexOf(f) !== -1;
    });

    var activas = estado.licencias.filter(function (l) { return l.dias_restantes > 0; }).length;
    var vencidas = estado.licencias.filter(function (l) { return l.dias_restantes <= 0; }).length;
    var porVencer = estado.licencias.filter(function (l) { return l.dias_restantes > 0 && l.dias_restantes <= 30; }).length;

    app.innerHTML =
      '<header class="cabecera">' +
      '<div class="crecer"><h1>Servidor de licencias</h1>' +
      '<div class="cabecera__sub">' + estado.licencias.length + ' institución(es) · llave ' + esc(estado.keyId || '—') + '</div></div>' +
      '<button class="boton boton--secundario" id="verificar">Verificar licencia</button>' +
      '<button class="boton" id="nueva">+ Nueva licencia</button>' +
      '</header>' +
      '<main class="contenido">' +
      '<div class="rejilla rejilla--metricas mb-3">' +
      metrica('Instituciones', estado.licencias.length, 'con licencia emitida', '') +
      metrica('Vigentes', activas, 'pueden operar', activas ? 'bien' : '') +
      metrica('Por vencer', porVencer, 'en los próximos 30 días', porVencer ? 'alerta' : '') +
      metrica('Vencidas', vencidas, 'necesitan renovación', vencidas ? 'peligro' : '') +
      '</div>' +

      (estado.licencias.length
        ? '<div class="tarjeta"><div class="tarjeta__cabecera">' +
          '<div class="buscador"><input class="entrada" id="filtro" placeholder="Buscar institución…" value="' + esc(estado.filtro) + '"></div>' +
          '<span class="crecer"></span></div>' +
          (lista.length
            ? '<div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
              '<th>Institución</th><th>Cliente</th><th>Vigencia</th><th>Días</th><th>Límites</th><th>Equipos</th><th></th>' +
              '</tr></thead><tbody>' +
              lista.map(fila).join('') +
              '</tbody></table></div>'
            : vacio('Ninguna institución coincide con la búsqueda')) +
          '</div>'
        : tarjetaVacia()) +
      '</main>';

    document.getElementById('nueva').addEventListener('click', function () { formularioNueva(); });
    document.getElementById('verificar').addEventListener('click', function () { formularioVerificar(); });

    var filtro = document.getElementById('filtro');
    if (filtro) {
      filtro.addEventListener('input', function () {
        estado.filtro = filtro.value.trim();
        // Se repinta solo la tabla, para no perder el foco del buscador.
        var t = document.querySelector('.tabla-envoltura');
        if (t) t.outerHTML = '<div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
          '<th>Institución</th><th>Cliente</th><th>Vigencia</th><th>Días</th><th>Límites</th><th>Equipos</th><th></th>' +
          '</tr></thead><tbody>' + estado.licencias.filter(function (l) {
            var f = estado.filtro.toLowerCase();
            return !f || (l.tenant || '').indexOf(f) !== -1 || (l.cliente || '').toLowerCase().indexOf(f) !== -1;
          }).map(fila).join('') + '</tbody></table></div>';
        conectarAcciones();
      });
    }

    conectarAcciones();
  }

  function metrica(etiqueta, valor, nota, tipo) {
    return '<div class="metrica ' + (tipo ? 'metrica--' + tipo : '') + '">' +
      '<div class="metrica__etiqueta">' + esc(etiqueta) + '</div>' +
      '<div class="metrica__valor">' + valor + '</div>' +
      '<div class="metrica__nota">' + esc(nota) + '</div></div>';
  }

  function vacio(texto) {
    return '<div class="vacio"><div class="vacio__icono">🔍</div><h3>' + esc(texto) + '</h3></div>';
  }

  function tarjetaVacia() {
    return '<div class="tarjeta"><div class="tarjeta__cuerpo">' +
      '<div class="vacio">' +
      '<div class="vacio__icono">🔑</div>' +
      '<h3>Todavía no hay licencias emitidas</h3>' +
      '<p>Emita la primera licencia para dar de alta una institución. Con ella, esa instalación podrá activarse y funcionar sin Internet.</p>' +
      '<button class="boton" id="nueva-vacia">Emitir la primera licencia</button>' +
      '</div></div></div>';
  }

  function fila(l) {
    var vencida = l.dias_restantes <= 0;
    var porVencer = !vencida && l.dias_restantes <= 30;
    var etiqueta = vencida
      ? '<span class="etiqueta etiqueta--peligro">Vencida</span>'
      : porVencer
      ? '<span class="etiqueta etiqueta--alerta">' + l.dias_restantes + ' días</span>'
      : '<span class="etiqueta etiqueta--bien">' + l.dias_restantes + ' días</span>';

    return '<tr>' +
      '<td><div class="tabla__principal texto-mono">' + esc(l.tenant) + '</div>' +
      '<div class="tabla__secundario">' + esc(l.tipo || '') +
      (l.huella ? ' · amarrada a un equipo' : '') + '</div></td>' +
      '<td><div>' + esc(l.cliente || '—') + '</div>' +
      (l.instalaciones && l.instalaciones.length
        ? '<div class="tabla__secundario">' + l.instalaciones.length + ' equipo(s) activado(s)</div>'
        : '<div class="tabla__secundario">sin activar</div>') + '</td>' +
      '<td class="texto-chico">' + fecha(l.desde) + '<br>hasta ' + fecha(l.hasta) + '</td>' +
      '<td>' + etiqueta + '</td>' +
      '<td class="texto-chico">' + (l.limites ? l.limites.usuarios + ' usuarios<br>' + l.limites.instalaciones + ' equipo(s)' : '—') + '</td>' +
      '<td class="texto-chico">' + ((l.instalaciones || []).length || '—') + '</td>' +
      '<td><div class="tabla__acciones">' +
      '<button class="boton boton--secundario boton--chico" data-renovar="' + esc(l.tenant) + '">Renovar</button>' +
      '<button class="boton boton--fantasma boton--chico" data-archivo="' + esc(l.tenant) + '" title="Descargar archivo">↓</button>' +
      '<button class="boton boton--fantasma boton--chico" data-ver="' + esc(l.tenant) + '" title="Ver detalle">👁</button>' +
      '</div></td></tr>';
  }

  function conectarAcciones() {
    document.querySelectorAll('[data-renovar]').forEach(function (b) {
      b.addEventListener('click', function () { formularioRenovar(b.dataset.renovar); });
    });
    document.querySelectorAll('[data-archivo]').forEach(function (b) {
      b.addEventListener('click', function () { descargar(b.dataset.archivo); });
    });
    document.querySelectorAll('[data-ver]').forEach(function (b) {
      b.addEventListener('click', function () { verDetalle(b.dataset.ver); });
    });
    var nv = document.getElementById('nueva-vacia');
    if (nv) nv.addEventListener('click', function () { formularioNueva(); });
  }

  /* ------------------------------------------------------------------ */
  /* Dialogos                                                            */
  /* ------------------------------------------------------------------ */

  function dialogo(titulo, cuerpoHtml, pieHtml) {
    var dlg = el('dialog', { clase: 'dialogo' });
    dlg.innerHTML =
      '<div class="dialogo__cabecera"><h2>' + esc(titulo) + '</h2>' +
      '<button class="boton boton--fantasma boton--chico" data-cerrar>×</button></div>' +
      '<div class="dialogo__cuerpo">' + cuerpoHtml + '</div>' +
      (pieHtml === false ? '' : '<div class="dialogo__pie">' + (pieHtml || '<button class="boton boton--secundario" data-cerrar>Cerrar</button>') + '</div>');

    dlg.querySelectorAll('[data-cerrar]').forEach(function (b) {
      b.addEventListener('click', function () { dlg.close(); });
    });
    document.body.appendChild(dlg);
    dlg.addEventListener('close', function () { dlg.remove(); });
    dlg.showModal();
    return dlg;
  }

  function casillaModulo(m) {
    return '<label class="casilla"><input type="checkbox" class="interruptor" data-modulo="' + esc(m) + '" checked>' +
      '<span>' + esc(m) + '</span></label>';
  }

  /* --- Emitir una licencia nueva --- */
  function formularioNueva() {
    dialogo(
      'Nueva licencia',
      '<div class="aviso aviso--info"><div class="texto-chico">El identificador de la institución es lo que se escribe al entrar al sistema. ' +
      'Use minúsculas, números y guiones (por ejemplo <span class="texto-mono">junta-los-prados</span>). No se puede cambiar después.</div></div>' +

      '<div class="fila-campos">' +
      campo('n-tenant', 'Identificador de la institución', '', true, 'text', 'junta-los-prados') +
      campo('n-cliente', 'Nombre del cliente', '', true, 'text', 'Junta de Vecinos Los Prados') +
      '</div>' +
      '<div class="fila-campos">' +
      campo('n-contacto', 'Correo de contacto', '', false, 'email', 'presidencia@ejemplo.org') +
      campo('n-dias', 'Días de vigencia', '365', true, 'number') +
      '</div>' +
      '<div class="fila-campos fila-campos--3">' +
      '<div class="campo"><label class="campo__etiqueta" for="n-tipo">Tipo</label>' +
      '<select class="selector" id="n-tipo">' +
      '<option value="prueba">Prueba</option>' +
      '<option value="periodo" selected>Por período</option>' +
      '<option value="anual">Anual</option>' +
      '<option value="permanente">Permanente</option>' +
      '</select></div>' +
      campo('n-usuarios', 'Usuarios permitidos', '5', true, 'number') +
      campo('n-instalaciones', 'Equipos permitidos', '1', true, 'number') +
      '</div>' +
      '<div class="fila-campos">' +
      campo('n-gracia', 'Días de gracia al vencer', '15', false, 'number') +
      campo('n-huella', 'Huella del equipo (opcional)', '', false, 'text', 'Deje vacío para cualquier equipo') +
      '</div>' +
      '<div class="campo"><label class="campo__etiqueta">Módulos incluidos</label>' +
      '<div class="casillas">' + estado.modulos.map(casillaModulo).join('') + '</div>' +
      '<div class="campo__ayuda">Si su licencia no incluye un módulo, esa parte del sistema queda bloqueada.</div></div>' +
      '<div class="campo"><label class="campo__etiqueta" for="n-notas">Notas internas</label>' +
      '<input class="entrada" id="n-notas" placeholder="Solo las ve usted"></div>',

      '<button class="boton boton--secundario" data-cerrar>Cancelar</button>' +
      '<button class="boton" id="n-emitir">Emitir licencia</button>'
    );

    document.getElementById('n-emitir').addEventListener('click', function () {
      var modulos = Array.prototype.slice.call(document.querySelectorAll('[data-modulo]'))
        .filter(function (c) { return c.checked; })
        .map(function (c) { return c.dataset.modulo; });

      var cuerpo = {
        tenant: document.getElementById('n-tenant').value.trim(),
        cliente: document.getElementById('n-cliente').value.trim(),
        contacto: document.getElementById('n-contacto').value.trim(),
        dias: Number(document.getElementById('n-dias').value) || 365,
        tipo: document.getElementById('n-tipo').value,
        usuarios: Number(document.getElementById('n-usuarios').value) || 5,
        instalaciones: Number(document.getElementById('n-instalaciones').value) || 1,
        gracia_dias: Number(document.getElementById('n-gracia').value) || 15,
        huella: document.getElementById('n-huella').value.trim() || null,
        modulos: modulos,
        notas: document.getElementById('n-notas').value.trim(),
      };

      if (!cuerpo.tenant || !cuerpo.cliente) {
        aviso('aviso', 'Faltan datos', 'El identificador y el nombre del cliente son obligatorios.');
        return;
      }

      var boton = document.getElementById('n-emitir');
      boton.disabled = true;
      boton.textContent = 'Emitiendo…';

      pedir('POST', '/api/admin/licencias', cuerpo)
        .then(function (r) {
          document.querySelector('.dialogo').close();
          mostrarLicencia(r, 'Licencia emitida');
          cargar();
        })
        .catch(function (e) {
          aviso('peligro', 'No se pudo emitir', e.message);
          boton.disabled = false;
          boton.textContent = 'Emitir licencia';
        });
    });
  }

  function campo(id, etiqueta, valor, obligatorio, tipo, marcador) {
    return '<div class="campo"><label class="campo__etiqueta" for="' + id + '">' + esc(etiqueta) +
      (obligatorio ? ' <span class="req">*</span>' : '') + '</label>' +
      '<input class="entrada" type="' + (tipo || 'text') + '" id="' + id + '" value="' + esc(valor || '') + '"' +
      (marcador ? ' placeholder="' + esc(marcador) + '"' : '') + '></div>';
  }

  /* --- Mostrar el archivo emitido, para copiarlo --- */
  function mostrarLicencia(r, titulo) {
    var texto = r.archivo || r.licencia || '';
    var resumen = r.resumen || '';

    dialogo(
      titulo,
      '<div class="aviso aviso--exito"><div><strong>Listo.</strong> ' +
      'Entregue este archivo a la institución. Se activa desde la pantalla de Licencia del sistema, pegando su contenido.</div></div>' +
      '<div class="campo"><label class="campo__etiqueta">Contenido del archivo</label>' +
      '<textarea class="area entrada--mono" id="archivo-lic" rows="9" readonly>' + esc(texto) + '</textarea></div>' +
      (resumen ? '<div class="campo"><label class="campo__etiqueta">Resumen</label>' +
        '<pre class="resumen">' + esc(resumen) + '</pre></div>' : ''),
      '<button class="boton boton--secundario" data-cerrar>Cerrar</button>' +
      '<button class="boton" id="copiar-lic">Copiar el contenido</button>'
    );

    document.getElementById('copiar-lic').addEventListener('click', function () {
      var area = document.getElementById('archivo-lic');
      area.select();
      try {
        navigator.clipboard.writeText(area.value).then(function () {
          aviso('exito', 'Copiado', 'Péguelo en la pantalla de Licencia del sistema.');
        }, function () {
          document.execCommand('copy');
          aviso('exito', 'Copiado');
        });
      } catch (e) {
        document.execCommand('copy');
        aviso('exito', 'Copiado');
      }
    });
  }

  /* --- Renovar --- */
  function formularioRenovar(tenant) {
    var l = estado.licencias.filter(function (x) { return x.tenant === tenant; })[0];
    if (!l) return;

    dialogo(
      'Renovar ' + tenant,
      '<div class="aviso aviso--info"><div class="texto-chico">La renovación se suma a partir de la fecha de vencimiento actual (' +
      fecha(l.hasta) + '). Si la licencia ya venció, se cuenta desde hoy.</div></div>' +
      '<div class="fila-campos">' +
      campo('r-dias', 'Días a agregar', '365', true, 'number') +
      '<div class="campo"><label class="campo__etiqueta" for="r-tipo">Tipo</label>' +
      '<select class="selector" id="r-tipo">' +
      ['prueba', 'periodo', 'anual', 'permanente'].map(function (t) {
        return '<option value="' + t + '"' + (l.tipo === t ? ' selected' : '') + '>' + t + '</option>';
      }).join('') +
      '</select></div>' +
      '</div>' +
      '<div class="fila-campos">' +
      campo('r-usuarios', 'Usuarios permitidos', l.limites ? l.limites.usuarios : 5, false, 'number') +
      campo('r-instalaciones', 'Equipos permitidos', l.limites ? l.limites.instalaciones : 1, false, 'number') +
      '</div>' +
      '<div class="campo"><label class="campo__etiqueta">Módulos incluidos</label>' +
      '<div class="casillas">' + estado.modulos.map(function (m) {
        var activo = (l.modulos || []).indexOf(m) !== -1;
        return '<label class="casilla"><input type="checkbox" class="interruptor" data-rmodulo="' + esc(m) + '"' +
          (activo ? ' checked' : '') + '><span>' + esc(m) + '</span></label>';
      }).join('') + '</div></div>',

      '<button class="boton boton--secundario" data-cerrar>Cancelar</button>' +
      '<button class="boton" id="r-renovar">Renovar</button>'
    );

    document.getElementById('r-renovar').addEventListener('click', function () {
      var modulos = Array.prototype.slice.call(document.querySelectorAll('[data-rmodulo]'))
        .filter(function (c) { return c.checked; })
        .map(function (c) { return c.dataset.rmodulo; });

      var boton = document.getElementById('r-renovar');
      boton.disabled = true;
      boton.textContent = 'Renovando…';

      pedir('POST', '/api/admin/licencias/' + encodeURIComponent(tenant) + '/renovar', {
        dias: Number(document.getElementById('r-dias').value) || 365,
        tipo: document.getElementById('r-tipo').value,
        modulos: modulos,
        limites: {
          usuarios: Number(document.getElementById('r-usuarios').value) || 5,
          instalaciones: Number(document.getElementById('r-instalaciones').value) || 1,
          visitas_mes: l.limites ? l.limites.visitas_mes : 0,
        },
      })
        .then(function (r) {
          document.querySelector('.dialogo').close();
          mostrarLicencia(r, 'Licencia renovada');
          cargar();
        })
        .catch(function (e) {
          aviso('peligro', 'No se pudo renovar', e.message);
          boton.disabled = false;
          boton.textContent = 'Renovar';
        });
    });
  }

  /* --- Detalle --- */
  function verDetalle(tenant) {
    var l = estado.licencias.filter(function (x) { return x.tenant === tenant; })[0];
    if (!l) return;

    var instalaciones = (l.instalaciones || []).length
      ? l.instalaciones.map(function (i) {
          return '<div class="ficha__dato"><dt>' + esc((i.equipo && i.equipo.nombre) || 'Equipo') + '</dt>' +
            '<dd class="texto-mono texto-chico">' + esc(i.huella) + '<br>última vez: ' + fecha(i.ultima_vez, true) + '</dd></div>';
        }).join('')
      : '<div class="texto-suave texto-chico">Esta licencia todavía no se ha activado en ningún equipo.</div>';

    dialogo(
      tenant,
      '<dl class="ficha__datos">' +
      '<div class="ficha__dato"><dt>Cliente</dt><dd>' + esc(l.cliente || '—') + '</dd></div>' +
      '<div class="ficha__dato"><dt>Identificador</dt><dd class="texto-mono">' + esc(l.licencia_id) + '</dd></div>' +
      '<div class="ficha__dato"><dt>Contacto</dt><dd>' + esc(l.contacto || '—') + '</dd></div>' +
      '<div class="ficha__dato"><dt>Tipo</dt><dd>' + esc(l.tipo || '—') + '</dd></div>' +
      '<div class="ficha__dato"><dt>Vigencia</dt><dd>' + fecha(l.desde) + ' → ' + fecha(l.hasta) + '</dd></div>' +
      '<div class="ficha__dato"><dt>Días restantes</dt><dd>' + l.dias_restantes + '</dd></div>' +
      '<div class="ficha__dato"><dt>Módulos</dt><dd>' + (l.modulos || []).join(', ') + '</dd></div>' +
      '<div class="ficha__dato"><dt>Límites</dt><dd>' + (l.limites ? l.limites.usuarios + ' usuarios, ' + l.limites.instalaciones + ' equipos' : '—') + '</dd></div>' +
      '<div class="ficha__dato"><dt>Amarrada a</dt><dd class="texto-mono texto-chico">' + esc(l.huella || 'cualquier equipo') + '</dd></div>' +
      '<div class="ficha__dato"><dt>Revisiones</dt><dd>' + (l.historial || 0) + '</dd></div>' +
      '</dl>' +
      '<h3 class="mt-3 mb-1">Equipos que la activaron</h3>' + instalaciones,
      '<button class="boton boton--secundario" data-cerrar>Cerrar</button>' +
      '<button class="boton" id="d-archivo">Descargar archivo</button>'
    );

    document.getElementById('d-archivo').addEventListener('click', function () { descargar(tenant); });
  }

  /* --- Descargar el archivo .vflow --- */
  function descargar(tenant) {
    fetch('/api/admin/licencias/' + encodeURIComponent(tenant) + '/archivo', {
      headers: { Authorization: 'Bearer ' + token },
    })
      .then(function (r) {
        if (!r.ok) throw new Error('No se pudo descargar (' + r.status + ')');
        return r.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = tenant + '.vflow';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      })
      .catch(function (e) { aviso('peligro', 'No se pudo descargar', e.message); });
  }

  /* --- Verificar una licencia pegada --- */
  function formularioVerificar() {
    dialogo(
      'Verificar una licencia',
      '<div class="campo"><label class="campo__etiqueta">Pegue el contenido del archivo</label>' +
      '<textarea class="area entrada--mono" id="v-texto" rows="8" placeholder="-----BEGIN VISITAFLOW LICENSE-----"></textarea>' +
      '<div class="campo__ayuda">Comprueba que la firma sea válida y que la licencia no haya sido alterada.</div></div>' +
      '<div id="v-resultado"></div>',
      '<button class="boton boton--secundario" data-cerrar>Cerrar</button>' +
      '<button class="boton" id="v-verificar">Verificar</button>'
    );

    document.getElementById('v-verificar').addEventListener('click', function () {
      var texto = document.getElementById('v-texto').value.trim();
      if (!texto) return;
      var res = document.getElementById('v-resultado');
      res.innerHTML = '<div class="cargando"><div class="girador"></div></div>';

      pedir('POST', '/api/admin/verificar', { archivo: texto })
        .then(function (r) {
          var e = r.evaluacion;
          var clase = e.valida ? 'exito' : 'peligro';
          res.innerHTML =
            '<div class="aviso aviso--' + clase + '"><div>' +
            '<strong>' + (e.valida ? 'Licencia válida' : 'Licencia NO válida') + '</strong>' +
            '<div>' + esc(e.motivo || 'La firma es correcta.') + '</div></div></div>' +
            '<pre class="resumen">' + esc(r.resumen) + '</pre>';
        })
        .catch(function (err) {
          res.innerHTML = '<div class="aviso aviso--peligro"><div>' + esc(err.message) + '</div></div>';
        });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Arranque                                                            */
  /* ------------------------------------------------------------------ */

  try {
    token = sessionStorage.getItem('vf_admin_token');
  } catch (e) {
    token = null;
  }

  /* Si la direccion trae un token (utilidad de desarrollo y capturas de
     pantalla), se usa ese. Se borra de la barra de direcciones enseguida para
     que no quede a la vista ni en el historial. */
  var enUrl = location.search.match(/[?&]t=([^&]+)/);
  if (enUrl) {
    try {
      token = decodeURIComponent(enUrl[1]);
      sessionStorage.setItem('vf_admin_token', token);
    } catch (e) {
      token = decodeURIComponent(enUrl[1]);
    }
    history.replaceState(null, '', location.pathname);
  }

  if (!token) pantallaToken();
  else cargar();
})();
