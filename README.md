# docker-dash

Dashboard de terminal para **Docker (via Colima)** e **Podman (via podman machine)**, feito com
[Gridland](https://github.com/thoughtfulllc/gridland). Mostra containers, estatísticas ao vivo, logs, imagens,
volumes e uso de disco, executa os comandos do dia a dia com uma tecla e faz uma limpeza completa para liberar espaço.

## Instalação

Você precisa de pelo menos um dos motores instalado: `brew install colima docker` ou `brew install podman`. Depois, rode:

```bash
./install.sh          # ou dê duplo clique em install.command no Finder
```

O instalador:
1. instala o [Bun](https://bun.sh), se ainda não existir (ele só é usado para compilar);
2. compila um **binário único**, que roda sem Bun nem Node;
3. copia o binário para `~/.local/bin/docker-dash` e adiciona essa pasta ao PATH no `~/.zshrc`.

Em seguida, abra um terminal novo e digite:

```bash
docker-dash            # abre com o último motor escolhido; na 1ª vez, mostra a tela de escolha
docker-dash --docker   # direto no Docker + Colima
docker-dash --podman   # direto no Podman
docker-dash --mock     # dados simulados (combine com --docker/--podman)
docker-dash --help
```

A última escolha fica salva em `~/.config/docker-dash/config.json` e é usada direto nas próximas vezes (sem perguntar).
Para fixar um motor, use `export DOCKER_DASH_ENGINE=podman`. Dentro do app, `E` volta para a tela de escolha.

Para atualizar depois de mudar o código, rode `./install.sh` de novo. Para remover, use `./uninstall.sh`.
Para instalar em outro lugar: `PREFIX=/usr/local ./install.sh` (o binário vai para `/usr/local/bin`).

## Desenvolvimento

```bash
bun install
bun start            # roda direto do código-fonte
bun run mock         # dados simulados
bun run compile      # só gera build/docker-dash, sem instalar
```

## O que tem

**1 · Containers**: lista com estado, CPU, memória, portas e status. Ao lado ficam os detalhes do container
selecionado: comando, redes, mounts, portas, sparklines de CPU e memória, rede e disco, além das últimas linhas de log.

| tecla | ação |
|---|---|
| `s` | start / stop |
| `r` | restart |
| `p` | pause / unpause |
| `d` | remover (pede confirmação; força se estiver rodando) |
| `l` | logs em tela cheia (↑↓ pgup/pgdn rolam, `f` volta a seguir) |
| `e` | copia `docker exec -it <nome> sh` para o clipboard |
| `o` | abre `http://localhost:<porta>` no navegador |
| `a` | alterna entre todos os containers e só os que estão rodando |

**2 · Imagens**: tamanho, idade e quantos containers usam cada imagem. `n` faz pull, `d` remove e `P` limpa as `<none>`.

**3 · Volumes**: mostra quais containers usam cada volume. `d` remove, `P` remove os não usados.

**4 · Sistema**: perfis do Colima ou máquinas do Podman (CPU, RAM, disco, runtime), uso total de CPU e RAM da VM, maiores
consumidores e `docker system df`. `S` start, `X` stop, `R` restart da VM, `P` system prune, `B` limpa o build cache.

**Limpeza (`C`)**: abre um painel com tudo que dá para apagar e uma estimativa do espaço de cada item:

| item | comando | padrão |
|---|---|---|
| Containers parados | `container prune` | ✓ |
| Imagens `<none>` | `image prune` | ✓ |
| Imagens sem nenhum container | `image prune -a` | |
| Redes não usadas | `network prune` | ✓ |
| Build cache (só Docker) | `builder prune -a` | ✓ |
| Volumes sem container (**apaga dados**) | `volume prune -a` | |

`espaço` marca ou desmarca, `a` marca tudo que é seguro e `enter` executa as etapas em sequência. No fim,
o painel mostra quanto espaço foi liberado de verdade, comparando o `system df` de antes e de depois.

**Geral**: `1`–`4`/`tab` trocam de aba, `C` abre a limpeza, `E` troca de motor, `/` filtra, `u` atualiza, `?` abre a ajuda e `q` sai.

Ações destrutivas (remover, prune, parar o Colima) sempre pedem confirmação.

## Como funciona

```
src/
├── cli.tsx              entrada (terminal): flags, config, escolhe o backend
├── Root.tsx             tela de escolha do motor → dashboard
├── DockerDash.tsx       UI: abas, tabelas, detalhes, modais, limpeza, teclado
├── useDashData.ts       polling: containers 2s, stats 2.5s, colima 5s, imagens/volumes/disco 15s
├── backend/
│   ├── types.ts         interface Backend
│   ├── exec.ts          execFile, parsing de JSON, detecção dos motores
│   ├── docker.ts        `docker ... --format '{{json .}}'` + `colima list --json`
│   ├── podman.ts        `podman ... --format json` + `podman machine list` (converte o JSON do Podman)
│   └── mock.ts          backend falso
└── lib/format.ts        bytes, portas, sparklines, tabelas
```

Os comandos são executados com `execFile` e os argumentos vão num array, sem shell. O Docker usa o contexto
ativo; com o Colima rodando, ele já aponta para o socket do Colima.

`bun run preview` abre a mesma UI no navegador, com dados simulados.
