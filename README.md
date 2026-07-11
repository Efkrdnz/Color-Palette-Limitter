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

No open-source license has been selected yet.

Without a license file, the default copyright position is that all rights are reserved by the author. People can view the repository on GitHub, but they do not automatically receive permission to copy, modify, redistribute, or use the project in their own work beyond what GitHub's terms allow for normal site use.

If you want others to freely use, modify, and share the project, add a license file. Common choices:

- MIT: simple and permissive, good if you want broad reuse with attribution.
- Apache-2.0: permissive like MIT, with extra patent language.
- GPL-3.0: requires derivative works to use the same license.

If you want to keep full control for now, leave the project unlicensed and keep `UNLICENSED` in `package.json`.
