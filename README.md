# La Villa · Facturación y tirillas de 80 mm

Abre `index.html` en el navegador (necesita internet para cargar las librerías). Dos pestañas:

- **Venta manual:** busca o filtra por categoría, toca un producto para agregarlo, ajusta cantidades con +/−, elige Precio 1 o 2, genera la vista previa y descarga el ticket. La venta se guarda sola si recargas.
- **Factura Siigo:** suelta o elige el PDF de Siigo; se convierte en tirilla de 80 mm con vista previa, QR y descarga.

## Archivos
- `index.html`, `style.css`: interfaz.
- `app.js`: lógica de la interfaz. Arriba tiene `CONFIG` (cuentas para consignar, QR desde CUFE).
- `productos.js`: catálogo (nombre, precios y categoría). Edítalo para agregar o cambiar productos.
- `tirilla.js`: motor compartido (PDF.js, parser, diseño, QR, jsPDF).

## En celulares (Android e iOS)
- Abre la app desde una dirección web (súbela a Netlify, GitHub Pages o similar). Desde archivos locales del celular puede no cargar.
- Usa Chrome (Android) o Safari (iPhone). Los navegadores dentro de WhatsApp, Instagram o Facebook suelen bloquear la descarga: abre el enlace en el navegador.
- Puedes «Agregar a pantalla de inicio» para usarla como app.
- Si aparece el botón **Compartir / imprimir**, abre la hoja del sistema (por ejemplo para enviar el PDF a una app de impresora térmica Bluetooth).

## Diseño adaptable
- Funciona en celulares pequeños (desde 320 px), celulares grandes, tablets y computador, en vertical y horizontal.
- En celular, la barra inferior muestra el total; toca el total para abrir y editar la venta, o «Generar ticket» para ir directo a la vista previa.
- Respeta las zonas seguras (notch y barra de gestos de iPhone) y evita el zoom automático al escribir.

## Impresión térmica
Papel de 80 mm, escala 100 %, sin «Ajustar a página» y márgenes mínimos. El tamaño final depende del controlador.

## Limitaciones
- Solo PDF con texto seleccionable (sin OCR).
- El análisis está pensado para el formato Siigo; otros formatos pueden requerir ajustes en `parse()` de `tirilla.js`.
- Si el QR del PDF no se puede leer, se genera con el CUFE y la URL de la DIAN.
