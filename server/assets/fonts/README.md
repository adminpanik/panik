# Vendored fonts (alert card)

`server/alertCard.ts` rasterises the Telegram alert card with `@resvg/resvg-js`,
which has no system fonts inside the container. These three faces ARE the card's
typography: a missing file is not a substituted face, it is an image with no text
on it, so they are committed rather than fetched.

They are the same two families the app uses (`--font-sans` / `--font-mono` in
`src/index.css`), which is the point: the card has to look like the product.

| File | Family / weight | Used for |
|---|---|---|
| `PlusJakartaSans-Bold.ttf` | Plus Jakarta Sans 700 | score numeral, event headline, wordmark, drill chip |
| `PlusJakartaSans-Medium.ttf` | Plus Jakarta Sans 500 | the identity line (label, protocol, chain) |
| `PlusJakartaSans-Regular.ttf` | Plus Jakarta Sans 400 | fallback for anything unweighted |
| `JetBrainsMono-Regular.ttf` | JetBrains Mono 400 | the wallet address |

The Medium face is loaded because the card DECLARES `font-weight="500"`. With only
400 and 700 available, fontdb resolves a declared 500 to one of them and the
markup ends up claiming a weight the image does not have.

## Provenance and licence

Both families are licensed under the **SIL Open Font License 1.1**, whose full
text is beside them (`PlusJakartaSans-OFL.txt`, `JetBrainsMono-OFL.txt`). The OFL
permits bundling and redistribution with software; it forbids selling the fonts
on their own and requires the copyright and licence to travel with them, which is
what those two files are here to do.

- Plus Jakarta Sans - Copyright 2020 The Plus Jakarta Sans Project Authors,
  <https://github.com/tokotype/PlusJakartaSans>
- JetBrains Mono - Copyright 2020 The JetBrains Mono Project Authors,
  <https://github.com/JetBrains/JetBrainsMono>

The `.ttf` files are the latin static instances Google Fonts serves for these
families (`fonts.gstatic.com`), unmodified. Neither file is renamed in a way that
would breach the OFL's reserved-name clause: the names above are the upstream
family names, which is what the OFL requires of an unmodified copy.
