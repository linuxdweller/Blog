---
title: "TypeScript with Neovim: The ultimate config guide"
date: "2025-07-02"
tag: { displayName: "Neovim", uriName: "neovim" }
description: ""
---

[Skip the fuss and see the full configuration.](#the-full-config)

In the past 2 years I've been improving the Neovim config I use everyday as a web
developer, creating the ultimate Neovim config for working with TypeScript in
Node, React, Angular and Astro projects.

While the ultimate Neovim config doesn't exist, this attempts to be as close as possible.
Everyone has their own preferences, and this article strives to give you the
tools to create the ultimate config _for you_.

If you're using Neovim for web development, you probably need:

1. Syntax highlighting.
2. Code completion.
3. Inline diagnostics from the TypeScript language server and `eslint`.
4. Find references / definitions / type definitions.
5. Format on save with `prettier`.
6. All the above working in `*.ts`, `*.js`, `*.tsx`, `*.jsx`, `*.css`, `*.scss`, `*.html`, `*.astro` files.

This article guides you through achieving all of these, providing the ultimate
developer experience.
We'll go through everything you'll need, while minimizing dependencies and config
size to make maintenance easy.

## Requirements

1. Neovim `v0.10.4`. I tested this config on `v0.10.4` and this is the version I recommend using with it. Some of the included
   plugins require `v0.10` or greater.
2. [folke/lazy.nvim](https://lazy.folke.io/installation) installed and setup.

## Code completion and snippets

Code completion is done with [`blink.cmp`](https://github.com/rafamadriz/friendly-snippets). For snippets we
use [`rafamadriz/friendly-snippets`](https://github.com/rafamadriz/friendly-snippets).

`curl` is required for this plugin to work. If you do not have it installed you will get an error when starting Neovim.

```lua
{
  "saghen/blink.cmp",
  dependencies = { "rafamadriz/friendly-snippets", "nvim-lua/plenary.nvim" },
  -- Use latest release tag pre-built binaries.
  version = "v0.*",
  -- `opts` is optional.
  opts = {
    keymap = {
      -- 'super-tab' for mappings similar to vscode (tab to accept, arrow keys to navigate).
      preset = "super-tab"
    },
    completion = {
      documentation = {
        -- Automatically show the documentation window when selecting a completion item.
        auto_show = true,
      },
    }
  }
}
```

## Language servers

Language servers provide code completion, diagnostics and code actions among other things.

### Astro Language Server

For configuring the [Astro language server](https://www.npmjs.com/package/@astrojs/language-server) we use `nvim-lspconfig`.

The Astro language server must be installed separately with `npm install --global @astrojs/language-server`.

```lua
{
  "neovim/nvim-lspconfig",
  dependencies = {
    "saghen/blink.cmp"
  },
  config = function(_, opts)
    local lspconfig = require("lspconfig")
    local capabilities = require("blink.cmp").get_lsp_capabilities()

    local servers = {
      "astro",
    }
    for _, lsp in pairs(servers) do
      lspconfig[lsp].setup {
        capabilities = capabilities
      }
    end
  end
},
```

### TypeScript Language Server

We use `typescript-tools.nvim` as our TypeScript language server. It performs better compared to other Typescript language servers, especially in large projects.

```lua
{
  "pmizio/typescript-tools.nvim",
  dependencies = { "nvim-lua/plenary.nvim", "neovim/nvim-lspconfig" },
},
```

## Linting and formatting

`none-ls` is used for configuring both auto format on save and diagnostics with `prettier` and `eslint`.
We are using `prettierd` and `eslint_d` instead of regular `prettier` and `eslint` for faster formatting.

[prettierd](https://github.com/fsouza/prettierd) and [eslint_d](https://github.com/mantoni/eslint_d.js/)
must be installed separately with `npm install --global eslint_d @fsouza/prettierd`.

```lua
{
  "nvimtools/none-ls.nvim",
  dependencies = {
    -- Required for eslint_d and prettierd sources.
    "nvimtools/none-ls-extras.nvim",
  },
  config = function()
    local augroup = vim.api.nvim_create_augroup("LspFormatting", {})
    local null_ls = require("null-ls")

    null_ls.setup({
      sources = {
        require("none-ls.diagnostics.eslint_d"),
        require("none-ls.formatting.eslint_d"),
        null_ls.builtins.formatting.prettierd,
      }

      -- Format on save.
      -- Source: https://github.com/nvimtools/none-ls.nvim/wiki/Formatting-on-save
      on_attach = function(client, bufnr)
        if client.supports_method("textDocument/formatting") then
            vim.api.nvim_clear_autocmds({ group = augroup, buffer = bufnr })
            vim.api.nvim_create_autocmd("BufWritePre", {
                group = augroup,
                buffer = bufnr,
                callback = function()
                    vim.lsp.buf.format({ async = false })
                end,
            })
        end
      end,
    })
  end
},
```

## LSP find references, definitions, type definitions

We use [`folke/snacks.nvim`](https://github.com/folke/snacks.nvim/blob/main/docs/picker.md) for searching through references, definitions and type definitions of the item under the cursor.

It is fast and requires minimal conifguration. folke is great. we love folke.

```lua
{
  "folke/snacks.nvim",
  keys = {
    { "<leader>fd", function() Snacks.picker.lsp_definitions() end, desc = "Goto definition." },
    { "<leader>fr", function() Snacks.picker.lsp_references() end, nowait = true, desc = "References" },
    { "<leader>ft", function() Snacks.picker.lsp_type_definitions() end, desc = "Goto Type Definition" },
  },
},
```

## Syntax Highlighting

We use [`nvim-treesitter`](https://github.com/nvim-treesitter/nvim-treesitter) for syntax highlighting.

```lua
{
  "nvim-treesitter/nvim-treesitter",
  -- Specify for lazy the main module to use for config() and opts().
  -- Required as lazy can not figure this out for treesitter automatically.
  main = "nvim-treesitter.configs",
  opts = {
    highlight = {
      -- Enable the sytax highlighting module. All modules are disabled by default.
      enable = true,
    },
    ensure_installed = {
      "css",
      "html",
      "javascript",
      "scss",
      "tsx",
      "typescript",
    },
    -- Automatically install missing parsers when entering buffer.
    auto_install = true,
  }
  -- Lazy will execute this on install or update of the plugin.
  -- This updates parsers when the plugin is updated or installed.
  build = ":TSUpdate",
},
```

## The full config

```lua
require("lazy").setup({
  {
    "saghen/blink.cmp",
    dependencies = { "rafamadriz/friendly-snippets", "nvim-lua/plenary.nvim" },
    -- Use latest release tag pre-built binaries.
    version = "v0.*",
    -- `opts` is optional.
    opts = {
      keymap = {
        -- 'super-tab' for mappings similar to vscode (tab to accept, arrow keys to navigate).
        preset = "super-tab"
      },
      completion = {
        documentation = {
          -- Automatically show the documentation window when selecting a completion item.
          auto_show = true,
        },
      }
    }
  },
  {
    "neovim/nvim-lspconfig",
    dependencies = {
      "saghen/blink.cmp"
    },
    config = function(_, opts)
      local lspconfig = require("lspconfig")
      local capabilities = require("blink.cmp").get_lsp_capabilities()

      local servers = {
        "astro",
      }
      for _, lsp in pairs(servers) do
        lspconfig[lsp].setup {
          capabilities = capabilities
        }
      end
    end
  },
  {
    "pmizio/typescript-tools.nvim",
    dependencies = { "nvim-lua/plenary.nvim", "neovim/nvim-lspconfig" },
  },
  {
    "nvimtools/none-ls.nvim",
    dependencies = {
      -- Required for eslint_d and prettierd sources.
      "nvimtools/none-ls-extras.nvim",
    },
    config = function()
      local augroup = vim.api.nvim_create_augroup("LspFormatting", {})
      local null_ls = require("null-ls")

      null_ls.setup({
        sources = {
          require("none-ls.diagnostics.eslint_d"),
          require("none-ls.formatting.eslint_d"),
          null_ls.builtins.formatting.prettierd,
        },
        -- Format on save.
        -- Source: https://github.com/nvimtools/none-ls.nvim/wiki/Formatting-on-save
        on_attach = function(client, bufnr)
          if client.supports_method("textDocument/formatting") then
              vim.api.nvim_clear_autocmds({ group = augroup, buffer = bufnr })
              vim.api.nvim_create_autocmd("BufWritePre", {
                  group = augroup,
                  buffer = bufnr,
                  callback = function()
                      vim.lsp.buf.format({ async = false })
                  end,
              })
          end
        end,
      })
    end
  },
  {
    "folke/snacks.nvim",
    keys = {
      { "<leader>fd", function() Snacks.picker.lsp_definitions() end, desc = "Goto definition." },
      { "<leader>fr", function() Snacks.picker.lsp_references() end, nowait = true, desc = "References" },
      { "<leader>ft", function() Snacks.picker.lsp_type_definitions() end, desc = "Goto Type Definition" },
    },
  },
  {
    "nvim-treesitter/nvim-treesitter",
    -- Specify for lazy the main module to use for config() and opts().
    -- Required as lazy can not figure this out for treesitter automatically.
    main = "nvim-treesitter.configs",
    opts = {
      highlight = {
        -- Enable the sytax highlighting module. All modules are disabled by default.
        enable = true,
      },
      ensure_installed = {
        "css",
        "html",
        "javascript",
        "scss",
        "tsx",
        "typescript",
      },
      -- Automatically install missing parsers when entering buffer.
      auto_install = true,
    },
    -- Lazy will execute this on install or update of the plugin.
    -- This updates parsers when the plugin is updated or installed.
    build = ":TSUpdate"
  }
})
```

## Honorable Mentions

### telescope.nvim

[`telescope.nvim`](https://github.com/nvim-telescope/telescope.nvim) is the predecessor of `folke/snacks.nvim`.
It has very similar pickers for LSP find references / definitions / type definitions.
It's downsides are that it's fuzzy finder is slower and it's config is slightly more verbose compared to `snacks.nvim`.

### conform.nvim

[`conform.nvim`](https://github.com/stevearc/conform.nvim) is a lightweight formatter plugin. It is probably the most popular formatter plugin. Still, I prefer using `none-ls` as
configuring formatting sources is a mere `require` call instead of specifying formatters manually for each filetype.

### nvim-lint

[`nvim-lint`](https://github.com/mfussenegger/nvim-lint) is an async linter plugin. Similarly to `conform.nvim`, I prefer
using `none-ls` for linter diagnostics as configuring linters is easier and requires less configuration.
