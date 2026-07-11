# Color Palette Limitter

A small browser-based utility for reducing image color palettes and exporting ready-named PNG files. Images are processed locally in the browser, so uploaded files do not need a server.

## Features

- Process one image or a batch of images.
- Choose a color limit from 1 to 256.
- Preview each reduced-color output.
- View the generated palette as labeled color swatches.
- Download a single PNG or a ZIP for batch output.
- Export filenames with the selected limit, such as `photo_lim8.png`.

## Usage

Open `index.html` in a browser, choose one or more image files, set the color limit, and select **Process images**.

For a local static server:

```bash
npm install
npm start
```

Then open `http://127.0.0.1:4173`.

## Testing

The test suite uses Playwright.

```bash
npm install
npm test
```

## Project Structure

- `index.html` contains the app markup.
- `styles.css` contains the visual styling and responsive layout.
- `script.js` contains image processing, palette reduction, downloads, and ZIP creation.
- `tests/` contains Playwright acceptance tests and a small local static server.

## Author

Efkrdnz

## License
No Open Source License
You may fork the project however you like and edit it.
