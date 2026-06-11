# Cruzeiro — Instalação e uso

## Requisitos
- Windows 10 ou superior
- Node.js LTS (https://nodejs.org)

---

## Primeira vez

1. **Coloque a pasta `Cruzeiro`** dentro do seu Dropbox
2. Abra o Prompt de Comando dentro da pasta e rode:
   ```
   npm install
   ```
3. Corrija o Electron (só na primeira vez):
   ```
   powershell -Command "[System.IO.File]::WriteAllText('node_modules\electron\path.txt', 'electron.exe')"
   ```
   ```
   powershell -Command "Expand-Archive -Path 'C:\Users\SEU_USUARIO\Downloads\electron-v28.3.3-win32-x64.zip' -DestinationPath 'node_modules\electron\dist' -Force"
   ```
   *(substitua SEU_USUARIO e o caminho do zip)*

4. Inicie o app:
   ```
   npm start
   ```

---

## Uso diário

Abra o Prompt de Comando na pasta Cruzeiro e rode:
```
npm start
```

Ou dê duplo clique no `iniciar.bat` (crie-o com o conteúdo abaixo):
```bat
@echo off
cd /d "%~dp0"
npm start
```

---

## Gerar executável .exe

Para gerar o executável sem precisar de privilégios de administrador:

```
npm run build
```

O executável será gerado em `C:\Cruzeiro-dist\win-unpacked\Cruzeiro.exe`

Para distribuir: copie a pasta `win-unpacked` para onde preferir.
O banco de dados `cruzeiro_data.db` fica na mesma pasta do `.exe`.

---

## Sincronização entre computadores

O arquivo `cruzeiro_data.db` sincroniza automaticamente pelo Dropbox.
A pasta `node_modules` **não** precisa estar no Dropbox — instale separadamente em cada máquina.

---

## Estrutura
```
Cruzeiro/
├── src/
│   ├── main.js        ← Banco de dados + lógica principal
│   ├── preload.js     ← API segura para o renderer
│   ├── index.html     ← Interface
│   └── renderer.js    ← Lógica da interface
├── assets/
│   ├── icon.ico       ← Ícone do app
│   └── icon.png       ← Ícone PNG
├── build.js           ← Script de build (npm run build)
├── package.json
└── INSTALAR.md
```
