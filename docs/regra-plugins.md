# Regra dos plugins do Harness

Este arquivo é a **fonte única** da regra de comportamento sobre plugins do
DeepSeek Harness. Ele é usado de duas formas:

- como documentação (leia e edite aqui);
- como carga do `install-agent-rule.sh`, que escreve o texto abaixo no arquivo de
  instruções do agente **que o Harness instalado estiver usando no momento** —
  hoje `$DSH_HOME/AGENTS.md`, descoberto a cada execução. Se o Harness mudar esse
  mecanismo, só o instalador precisa de ajuste; este texto continua valendo.

O bloco instalado fica delimitado por marcadores
`<!-- dsh-plugins:regra:inicio -->` / `<!-- dsh-plugins:regra:fim -->`, então
rodar o instalador de novo **atualiza** a regra sem duplicar nada e sem tocar em
qualquer outra coisa que você tenha escrito no arquivo do agente.

---

## Plugins do Harness → sempre em ~/dsh-plugins

Quando eu pedir um plugin novo para o DeepSeek Harness:

1. Crie em `~/dsh-plugins/<nome>/` — repositório Git próprio. **Nunca** dentro de um
   projeto de aplicação (Dog Assistent, CyberBot ou qualquer outro).
2. Siga o padrão da casa. Antes de escrever código, leia `~/dsh-plugins/README.md`,
   `~/dsh-plugins/DEPENDENCIAS.md` e `~/dsh-plugins/docs/contrato-plugins-dsh.md`:
   - `package.json` (nome `dsh-<nome>`), `install.sh` idempotente e `README.md`;
   - plugin com UI no navegador ⇒ pacote dual-face (`exports["./client"]` + `dsh.client`,
     bundle em script clássico com `window.__ModuleLoader__.load({ id, factory })`);
   - serviço que só existe em alguns perfis (ex.: `webServer`) ⇒ dependência **opcional**
     via `ctx.inject([...], cb)`, nunca dentro de `inject` (entry pendente derruba o boot);
   - nunca repetir o mesmo `id` de entry em camadas de patch diferentes (o Loader lança
     `duplicate loader entry id`).
3. A instalação é **global**: pacote em `$DSH_HOME/profiles/node_modules/<pacote>/` e entry em
   `$DSH_HOME/cordis.patch.yml` (camada do usuário = todos os perfis e todos os workspaces).
   Termine rodando `./install-all.sh` e `./doctor.sh`; se tiver UI, valide no navegador real
   (`.dev/browser-probe.mjs` e `.dev/browser-e2e.mjs` do voice-input são o modelo).
4. Atualize a documentação do repositório (`README.md` e `DEPENDENCIAS.md`) junto com o código.
5. Acrescente ao lado do que já existe: nunca altere um fluxo que já funciona.
6. Se o plugin precisar de algo pesado (modelo, dependência Python), mantenha tudo dentro da
   pasta do plugin (`vendor/`, `models/` — ambos fora do Git) e deixe o `install.sh` recriar.

## Git: perguntar SEMPRE antes

- **Nunca** rodar `git add`, `git commit` ou `git push` — em `~/dsh-plugins` ou em qualquer
  outro repositório — sem me perguntar antes e receber autorização explícita.
- Na pergunta, mostre os arquivos que entrariam, um resumo de uma linha e a mensagem de commit
  sugerida. Vale também para alterações em plugins que já existem.
- Autorização para um commit **não** vale para o próximo.
