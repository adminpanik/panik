# Vendored fonts (alert card)

`server/alertCard.ts` rasterises the Telegram alert card with `@resvg/resvg-js`,
which has no system fonts inside the container. These four faces ARE the card's
typography: a missing file is not a substituted face, it is an image with no text
on it, so they are committed rather than fetched.

They are the same two families the app uses (`--font-sans` / `--font-mono` in
`src/index.css`), which is the point: the card has to look like the product.
Weight 900 is NOT vendored, so the headline and the band word are set at 700,
the heaviest face the container actually holds.

| File | Family / weight | Used for |
|---|---|---|
| `Archivo-Bold.ttf` | Archivo 700 | headline, band word, wordmark, labels, drill tag |
| `Archivo-Regular.ttf` | Archivo 400 | the position line, the ledger row's words |
| `SpaceMono-Bold.ttf` | Space Mono 700 | the score numeral, the price-drop percentage |
| `SpaceMono-Regular.ttf` | Space Mono 400 | the wallet address |

## Provenance and licence

Both families are licensed under the **SIL Open Font License 1.1**, whose full
text is beside them (`Archivo-OFL.txt`, `SpaceMono-OFL.txt`), sourced from the
`google/fonts` GitHub repository (`ofl/archivo`, `ofl/spacemono`). The OFL
permits bundling, redistribution and modification with software; it forbids
selling the fonts on their own and requires the copyright and licence to travel
with them, which is what those two files are here to do.

- Archivo - Copyright 2020 The Archivo Project Authors,
  <https://github.com/Omnibus-Type/Archivo>
- Space Mono - Copyright 2016 The Space Mono Project Authors,
  <https://github.com/googlefonts/spacemono>

`SpaceMono-Regular.ttf` / `SpaceMono-Bold.ttf` are the static latin files Google
Fonts serves for that family, unmodified.

`Archivo-Regular.ttf` / `Archivo-Bold.ttf` are NOT copied unmodified: upstream
`google/fonts` ships Archivo only as a variable font
(`ofl/archivo/Archivo[wdth,wght].ttf`), and `@resvg/resvg-js` 2.6.2 does not
honour a requested `font-weight` against a variable font's `wght` axis - it
always rasterises the font's default named instance (SemiBold, 600) regardless
of what the SVG asks for, which was verified by rendering the same text at
`font-weight="400"` and `"700"` against the raw variable file and finding the
two outputs byte-identical. The two static files here are that variable font
instanced at `wght=400`/`wght=700`, `wdth=100`, with `fonttools.varLib.instancer`
(OFL-permitted modification), renamed to the plain family/subfamily names a
static face would carry. Re-instancing directly from
`ofl/archivo/Archivo[wdth,wght].ttf` reproduces them.

Neither file is renamed in a way that would breach the OFL's reserved-name
clause: the names above are the upstream family name, which is what the OFL
requires of an unmodified-in-substance copy.
