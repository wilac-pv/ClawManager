# Desktop icons

`../app-icon.png` is the single 1024x1024 RGBA source for the 如影 Code
placeholder icon. It must retain a transparent outer background and generous
platform-safe padding.

Regenerate every release channel from `packages/desktop`:

```sh
bun tauri icon -o icons/prod app-icon.png
bun tauri icon -o icons/beta app-icon.png
bun tauri icon -o icons/dev app-icon.png
cp icons/prod/128x128@2x.png icons/prod/dock.png
cp icons/beta/128x128@2x.png icons/beta/dock.png
cp icons/dev/128x128@2x.png icons/dev/dock.png
```

The three channels intentionally use the same placeholder. `copy-icons.ts`
copies only the generated macOS, Windows, and Linux desktop variants into the
build resources; do not edit those variants independently.
