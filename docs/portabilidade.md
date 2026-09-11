# Portabilidade: backup, restauração e troca de sistema

Objetivo: levar os plugins do DSH para outra máquina (ou recuperá-los depois de
formatar o computador) sem depender de memória nem de arquivos perdidos.

## O que o repositório já resolve

- Código dos dois plugins, com instaladores idempotentes.
- Registro do plugin no harness (as entries do `cordis.patch.yml` são recriadas
  pelo `install.sh` de cada plugin, com os caminhos absolutos corretos).
- Documentação de dependências e um diagnóstico (`doctor.sh`) que diz o que falta.

## O que NÃO está no repositório (e como volta)

| item | tamanho | como volta |
|---|---|---|
| `voice-input/vendor/` (faster-whisper + ctranslate2 + av + numpy…) | ~200 MB | `./install-all.sh` roda `pip3 install --target vendor faster-whisper` |
| `voice-input/models/` (Whisper tiny/small) | 75–464 MB cada | baixa do HuggingFace no primeiro uso, ou `VOICE_PRELOAD=1 ./install-all.sh` |
| modelo `gemma4:e2b` do Ollama (visão) | 7,2 GB | `ollama pull gemma4:e2b` |
| `node_modules/` dos plugins | symlink | não é preciso: só os self-tests usam |
| cópias instaladas em `~/.dsh/profiles/web/` | pequenas | recriadas pelo `install.sh` |

Configurações pessoais do harness **não** fazem parte deste repositório e
merecem backup separado, se você quiser preservá-las:

- `~/.dsh/settings.yaml` (modelo padrão, presets do agente)
- `~/.dsh/.credentials.yaml` (chaves de API — trate como segredo)
- `~/.dsh/profiles/web/cordis.patch.yml` (as entries dos plugins; útil se você
  personalizou `model:`, `language:`, portas etc.)
- `~/.dsh/sessions/` e `~/.dsh/storages/` (histórico das conversas)

## Backup (três caminhos)

### 1. Git (recomendado)

```bash
cd ~/dsh-plugins
git init
git add .
git commit -m "Plugins do DSH: voice-input e ollama-vision"
git remote add origin git@github.com:<usuario>/dsh-plugins.git
git push -u origin main
```

O `.gitignore` já barra `vendor/`, `models/`, `node_modules/` e `__pycache__/` —
o que sobe é só código e documentação (poucos KB).

### 2. Cópia em arquivo (sem Git)

```bash
tar czf dsh-plugins.tgz \
  --exclude vendor --exclude models --exclude node_modules --exclude __pycache__ \
  -C ~ dsh-plugins
```

### 3. Cópia completa, para reinstalar sem internet

Inclua também `voice-input/vendor/` (específico de Linux x86_64 + Python 3.10) e
`voice-input/models/`. Aí a restauração não baixa nada — só o modelo do Ollama
continua vindo do `ollama pull`.

## Restaurar em outra máquina (passo a passo)

1. Instale o DSH e rode `dsh web` uma vez, para ele criar `~/.dsh/profiles/web`.
2. Instale as dependências de sistema:

   ```bash
   sudo apt install python3 python3-pip ffmpeg   # voice-input
   # ollama: https://ollama.com/download         # ollama-vision
   ```

3. Copie/clone o repositório para `~/dsh-plugins`.
4. `cd ~/dsh-plugins && ./doctor.sh` — veja o que falta (só diagnostica).
5. `./install-all.sh` (com `VOICE_PRELOAD=1` na frente se quiser já baixar o
   modelo do Whisper).
6. Para a visão: `ollama pull gemma4:e2b` (~7,2 GB).
7. Recarregue a página do harness (**F5**) e teste.

## Checklist de verificação

- [ ] `./doctor.sh` termina sem `✘`.
- [ ] `curl -s http://127.0.0.1:3080/voice-input/status` responde `"state":"ready"`.
- [ ] O ícone de microfone aparece na barra do composer; uma fala curta vira texto
      na caixa de entrada.
- [ ] `vision_ask` responde sobre uma imagem de teste.

## Trocar de ambiente

| situação | o que fazer |
|---|---|
| outro `DSH_HOME` | `DSH_HOME=/caminho ./install-all.sh` |
| outra pasta para o repositório | mover e rodar `./install-all.sh` de novo (reescreve os caminhos absolutos no perfil) |
| outra distro Linux | igual; só confirme `python3`, `pip3` e `ffmpeg` |
| macOS | deve funcionar (ffmpeg e python3 via Homebrew); os `install.sh` foram escritos e testados em Linux — se o `install -m` reclamar, troque por `cp` |
| Windows | use WSL2 e siga os passos de Linux; no Windows nativo os instaladores não foram testados |
| sem GPU | nada muda: o Whisper roda em CPU (`device: cpu`, `computeType: int8`) |

## Remover um plugin

1. Apague o bloco `- insert:` correspondente em `~/.dsh/profiles/web/cordis.patch.yml`.
2. Recarregue a página (F5) — o host sai a quente e o worker Python morre junto.
3. Opcional: apague a cópia em `~/.dsh/profiles/web/node_modules/dsh-voice-input`
   (ou `~/.dsh/profiles/web/plugins/ollama-vision`).

O repositório e os modelos baixados continuam intactos, então reinstalar é só
rodar `install.sh` outra vez.

## Dicas para não perder trabalho

- Faça o commit **antes** de mexer em qualquer plugin: o `install.sh` copia para o
  perfil, mas a fonte da verdade é este repositório.
- Depois de mudar qualquer arquivo aqui, rode `./install-all.sh` de novo — o
  harness executa a cópia instalada, não o repositório.
- Se quiser versionar também os modelos (para reinstalar offline), use
  `git lfs` ou guarde o `.tgz` da opção 3 no backup.

## Por que isso vale para todos os repositórios

A instalação é feita no **harness**, não no projeto: os pacotes vão para
`~/.dsh/profiles/node_modules/` e as entries para `~/.dsh/cordis.patch.yml` (a
camada do usuário, aplicada sobre o patch de cada perfil). Resultado: qualquer
workspace aberto no harness — o de hoje e os de amanhã — tem o microfone no
composer e as ferramentas de visão, sem nenhuma configuração por projeto.

Para conferir depois de reinstalar:

```bash
dsh --profile web --dump-config | grep -c 'id: voice-input'        # 1
dsh --profile headless --dump-config | grep -c 'id: ollama-vision' # 1
```
