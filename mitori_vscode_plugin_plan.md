# Mitori — VS Code PostgreSQL Visualizer

## Product idea

Build a VS Code extension called **Mitori**.

Mitori gives developers a visual overview of their PostgreSQL database without leaving VS Code.

The goal is to bring some of the visibility of no-code tools like Bubble into a real-code development workflow, without replacing normal software engineering discipline.

Mitori should help developers see:

* schemas
* tables
* columns
* data types
* primary keys
* foreign keys
* relationships
* sample rows

inside VS Code.

***

## Core thesis

No-code tools give visibility but weak ownership.

Traditional code gives ownership but weaker visibility.

AI-assisted coding gives speed, but can make hidden complexity grow faster.

Mitori should help with the visibility layer:

> Make the current database structure visible while coding.

***

# MVP goal

Build **Mitori v0** as a read-only PostgreSQL database visualizer inside VS Code.

For this first version, do **not** build a migration manager.

The only goal is to inspect and understand the current PostgreSQL database from inside the editor.

***

# Important scope decision

Mitori v0 should avoid migration complexity.

Do **not** implement support for:

* Knex migrations
* Prisma migrations
* Drizzle migrations
* raw SQL migration runners
* seeds
* reset scripts
* production deployment
* schema editing
* row editing

Those can come later.

For now, Mitori should only visualize the current database state.

***

# Tech stack

Use:

* TypeScript
* VS Code Extension API
* Node.js
* `pg` for PostgreSQL connection
* `dotenv` for reading `.env`
* `pnpm` as package manager

For the first Webview, keep the UI simple.

Use:

* HTML
* CSS
* vanilla JavaScript if needed

Do not use React for v0 unless absolutely necessary.

***

# Target user

The first target user is a solo full-stack developer building apps with:

* VS Code
* Node.js / Express
* PostgreSQL
* `.env` files
* local development database

The user wants a Bubble-like sense of visibility, but inside a real-code stack.

***

# v0 requirements

## 1. Extension activation

Create a VS Code extension called **Mitori**.

When the extension activates, it should register:

* a sidebar view
* commands
* a PostgreSQL connection service
* a schema tree provider

The sidebar should be named:

```txt
Mitori
```

***

## 2. Read DATABASE\_URL from `.env`

The extension should inspect the current workspace root and look for:

```txt
.env
```

From that file, read:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/database_name"
```

If `DATABASE_URL` does not exist, show a friendly message in the sidebar:

```txt
No DATABASE_URL found.
Create a .env file with DATABASE_URL to connect Mitori.
```

Do not log the full database URL.

Do not expose passwords in the UI.

***

## 3. Connect to PostgreSQL

Use the `pg` package to connect to PostgreSQL.

The connection should be read-only from the UI perspective.

Mitori v0 should not allow:

* arbitrary SQL execution
* row editing
* table creation
* column creation
* destructive actions

The extension may run safe introspection queries and limited table preview queries.

***

## 4. Sidebar tree view

The sidebar should show:

```txt
Mitori

Connection
  ● Connected: database_name

Schemas
  public
    users
      id uuid PK
      email text
      password_hash text
      created_at timestamptz

    accounts
      id uuid PK
      user_id uuid FK → users.id
      name text
      type text
      currency text
      initial_balance numeric

    categories
      id uuid PK
      user_id uuid FK → users.id
      name text
      kind text
      color text

    transactions
      id uuid PK
      user_id uuid FK → users.id
      account_id uuid FK → accounts.id
      category_id uuid FK → categories.id
      amount numeric
      type text
      date date
      description text
```

The tree should support:

* schema nodes
* table nodes
* column nodes

Columns should visually indicate:

* primary key
* foreign key
* nullable / not nullable if possible
* data type

Foreign keys should show the referenced table and column.

Example:

```txt
user_id uuid FK → users.id
```

***

## 5. Table Webview

When the user clicks a table, open a Webview panel.

The panel should show:

```txt
Table: transactions
Schema: public

Columns:
- id uuid primary key not null
- user_id uuid foreign key → users.id not null
- account_id uuid foreign key → accounts.id not null
- category_id uuid foreign key → categories.id nullable
- amount numeric not null
- type text not null
- date date not null
- description text nullable
- created_at timestamptz not null

Preview:
first 100 rows
```

The row preview should be displayed as a simple table/grid.

The preview must be read-only.

***

## 6. PostgreSQL introspection

Use PostgreSQL introspection through:

* `information_schema`
* `pg_catalog`

For v0, assume the main schema is `public`, but structure the code so multiple schemas can be supported.

Implement functions for:

```ts
getSchemas()
getTables(schemaName)
getColumns(schemaName, tableName)
getPrimaryKeys(schemaName, tableName)
getForeignKeys(schemaName, tableName)
getIndexes(schemaName, tableName)
getTablePreview(schemaName, tableName, limit)
```

Indexes are optional for v0, but the code can include a placeholder.

***

## 7. Safe table preview

When previewing a table, run a safe query equivalent to:

```sql
SELECT * FROM "schema_name"."table_name" LIMIT 100;
```

Important safety rules:

* Do not directly interpolate arbitrary user input.
* Table names and schema names should come from introspection results.
* Escape PostgreSQL identifiers safely.
* Do not allow the user to type arbitrary SQL in v0.

Create a utility for safe identifier quoting.

Example:

```ts
quoteIdentifier(identifier: string): string
```

***

## 8. Commands

Add these VS Code commands:

```txt
Mitori: Connect to Database
Mitori: Refresh Database View
Mitori: Open Table Preview
Mitori: Explain Mitori
```

### Mitori: Explain Mitori

This command should show a message like:

```txt
Mitori is a read-only PostgreSQL visualizer for VS Code. It helps you see schemas, tables, columns, keys, relationships, and sample rows without leaving your editor.
```

***

# Non-goals for v0

Do not implement:

* migrations
* seed management
* reset commands
* Prisma support
* Knex support
* Drizzle support
* MongoDB support
* Neo4j support
* Qdrant support
* production editing
* data editing
* visual schema editing
* create table form
* add column form
* arbitrary SQL console
* AI assistant
* cloud sync
* authentication
* paid/pro features

***

# Project structure

Use this structure:

```txt
mitori/
  package.json
  pnpm-lock.yaml
  tsconfig.json
  README.md
  .vscodeignore

  src/
    extension.ts

    config/
      envLoader.ts
      workspace.ts

    db/
      postgresClient.ts
      introspection.ts
      types.ts

    views/
      mitoriTreeProvider.ts
      tableWebview.ts

    utils/
      identifiers.ts
      html.ts
      errors.ts
```

***

# Module responsibilities

## `src/extension.ts`

Responsible for:

* activating the extension
* registering commands
* registering the sidebar tree view
* initializing the database connection
* wiring services together

***

## `src/config/workspace.ts`

Responsible for:

* detecting the workspace root
* finding important files
* safely resolving project paths

***

## `src/config/envLoader.ts`

Responsible for:

* reading `.env`
* extracting `DATABASE_URL`
* returning a sanitized connection description

Do not display passwords.

***

## `src/db/postgresClient.ts`

Responsible for:

* creating a PostgreSQL connection pool
* testing the connection
* exposing a safe query method
* closing the pool when needed

Use `pg`.

***

## `src/db/introspection.ts`

Responsible for:

* listing schemas
* listing tables
* listing columns
* detecting primary keys
* detecting foreign keys
* preparing table metadata
* previewing table rows

Return typed objects defined in `types.ts`.

***

## `src/db/types.ts`

Define types like:

```ts
export interface DatabaseSchema {
  name: string;
}

export interface DatabaseTable {
  schema: string;
  name: string;
}

export interface DatabaseColumn {
  schema: string;
  table: string;
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  foreignKey?: ForeignKeyReference;
}

export interface ForeignKeyReference {
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
}
```

***

## `src/views/mitoriTreeProvider.ts`

Responsible for:

* building the VS Code TreeView
* showing connection state
* showing schemas
* showing tables
* showing columns
* refreshing the tree

Tree item hierarchy:

```txt
Connection
Schemas
  schema
    table
      column
```

***

## `src/views/tableWebview.ts`

Responsible for:

* opening a Webview for a selected table
* rendering table metadata
* rendering first 100 rows
* escaping HTML safely

Do not allow editing in v0.

***

## `src/utils/identifiers.ts`

Responsible for:

* safely quoting PostgreSQL identifiers
* validating schema/table/column names from introspection

***

## `src/utils/html.ts`

Responsible for:

* escaping HTML content
* preventing unsafe rendering inside Webviews

***

## `src/utils/errors.ts`

Responsible for:

* normalizing errors
* producing friendly messages

***

# UX details

## Empty state

If no workspace is open:

```txt
Open a workspace to use Mitori.
```

If no `.env` is found:

```txt
No .env file found.
Add DATABASE_URL to connect Mitori.
```

If `.env` exists but no `DATABASE_URL` is found:

```txt
No DATABASE_URL found in .env.
```

If connection fails:

```txt
Could not connect to PostgreSQL.
Check DATABASE_URL, database status, username, password, and port.
```

If no tables exist:

```txt
Connected, but no tables were found.
```

***

# Visual markers

Use simple labels:

```txt
PK
FK
nullable
not null
```

Examples:

```txt
id uuid PK not null
user_id uuid FK → users.id not null
description text nullable
```

***

# README content

Create a README with this structure:

```md
# Mitori

Mitori is a read-only PostgreSQL visualizer for VS Code.

It helps developers see schemas, tables, columns, keys, relationships, and sample rows without leaving the editor.

## Why Mitori exists

No-code tools make data visible.
Code-based tools give ownership.
Mitori tries to bring visibility into code-based development.

## Features

- Connects to PostgreSQL using DATABASE_URL
- Shows schemas
- Shows tables
- Shows columns
- Marks primary keys
- Marks foreign keys
- Shows sample rows
- Works inside VS Code
- Read-only by default

## Requirements

- VS Code
- Node.js
- pnpm
- PostgreSQL database
- `.env` file with `DATABASE_URL`

## Usage

1. Open a PostgreSQL project in VS Code.
2. Add `DATABASE_URL` to `.env`.
3. Open the Mitori sidebar.
4. Connect to the database.
5. Inspect tables and preview rows.

## What Mitori does not do yet

- migrations
- seeds
- editing rows
- editing schema
- production deployment
- arbitrary SQL console

## Roadmap

### v0
Read-only PostgreSQL visualization.

### v0.1
Better error states, row counts, search/filter in previews.

### v0.2
Relationship diagram.

### v0.3
Local row editing.

### v0.4
Migration awareness.

### v1
Bubble-like database cockpit inside VS Code.
```

***

# Roadmap

## v0 — Read-only PostgreSQL visualization

* Detect `.env`
* Read `DATABASE_URL`
* Connect to local PostgreSQL
* Show connection status
* Show schemas
* Show tables
* Show columns
* Mark primary keys
* Mark foreign keys
* Preview first 100 rows
* Stay fully read-only

***

## v0.1 — Better visibility

* Show row counts
* Show indexes
* Show constraints
* Better empty/error states
* Refresh button
* Local search/filter in row preview

***

## v0.2 — Relationship view

* Show relationships between tables
* Basic ER-style diagram
* Click relationship to inspect foreign key
* Highlight connected tables

***

## v0.3 — Local data editing

Only after v0 is stable.

Possible features:

* edit local rows
* insert local rows
* delete local rows
* keep production read-only
* require confirmation for deletes

***

## v0.4 — Migration awareness

Only after the migration strategy is clearer.

Possible support:

* raw SQL migrations
* Knex migrations
* Prisma migrations
* Drizzle migrations

For now, do not build this.

***

## v1 — Database cockpit

Long-term vision:

* database visualizer
* relationship diagram
* row editor
* migration awareness
* seed visibility
* local/prod comparison
* safe production read-only inspection
* possible AI explanation layer

***

# Acceptance criteria

The MVP is complete when:

1. I can open a PostgreSQL project in VS Code.
2. Mitori reads `DATABASE_URL` from `.env`.
3. Mitori connects to PostgreSQL.
4. The sidebar shows connection status.
5. The sidebar shows schemas.
6. Expanding a schema shows tables.
7. Expanding a table shows columns.
8. Columns show data type.
9. Primary keys are marked.
10. Foreign keys are marked and show references.
11. Clicking a table opens a Webview.
12. The Webview shows table metadata.
13. The Webview shows first 100 rows.
14. Everything is read-only.
15. No arbitrary SQL execution exists.
16. The README explains what Mitori is and what it does not do yet.

***

# Development order

Build in this order:

1. Scaffold VS Code extension with TypeScript.
2. Add sidebar TreeView named Mitori.
3. Add basic command registration.
4. Detect workspace root.
5. Read `.env`.
6. Extract `DATABASE_URL`.
7. Connect to PostgreSQL using `pg`.
8. Add connection status to sidebar.
9. Implement schema introspection.
10. Implement table introspection.
11. Implement column introspection.
12. Implement primary key detection.
13. Implement foreign key detection.
14. Render schemas/tables/columns in TreeView.
15. Add table click command.
16. Build table Webview.
17. Render first 100 rows.
18. Improve error states.
19. Write README.
20. Test on a local PostgreSQL project.

***

# Safety requirements

1. Do not expose database passwords.
2. Do not log full connection strings.
3. Do not allow arbitrary SQL execution.
4. Do not allow editing rows.
5. Do not allow editing schema.
6. Do not run migrations.
7. Do not run seed scripts.
8. Do not run reset scripts.
9. Only use table/schema names discovered from the database itself.
10. Escape identifiers and HTML safely.

***

# Final reminder for Codex

Build a working MVP.

Do not over-engineer.

Do not add migrations yet.

Do not add Prisma, Knex, Drizzle, MongoDB, Neo4j, Qdrant, or AI support yet.

Mitori v0 should do one thing well:

> Make my current PostgreSQL database visible inside VS Code.