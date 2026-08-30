# Sonómetro Online · Diplomado de Ingeniería Acústica

Aplicación web educativa para medición acústica desde el micrófono del navegador.

## V1
- Nivel instantáneo con ponderación A, C o Z.
- Respuesta FAST (125 ms) / SLOW (1 s).
- Leq,T energético, máximo y mínimo.
- Historia temporal.
- FFT en escala logarítmica.
- Bandas de 1/1 y 1/3 de octava.
- Offset de calibración configurable.
- Procesamiento local: el audio no se almacena ni se envía.

## Ejecutar
El acceso al micrófono requiere contexto seguro. En desarrollo use localhost, por ejemplo:

```bash
python -m http.server 8000
```

Luego abra `http://localhost:8000`.

Para producción, GitHub Pages, Netlify o Vercel proporcionan HTTPS.

## Calibración
La entrada del navegador no entrega SPL absoluto. Compare con un sonómetro de referencia bajo una señal estable y ajuste el `Offset de calibración` hasta igualar la lectura.

## Advertencia
Instrumento educativo/no certificado. No sustituye un sonómetro conforme IEC 61672 para mediciones reglamentarias.

## Diseño responsive V3
- Escritorio: tablero completo en dos columnas.
- Tablet / móvil: flujo vertical priorizando nivel, LAeq, máximos/mínimos, historia y espectro.
- En pantallas pequeñas, LAF/LAS instantáneo se muestra como lectura principal y la tarjeta redundante se oculta para ganar espacio.
- Los controles tienen áreas táctiles grandes y las bandas de frecuencia permiten desplazamiento horizontal.
- Incluye adaptación especial para teléfono en orientación horizontal.
