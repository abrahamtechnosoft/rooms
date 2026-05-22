# Technosoft.Rooms.v1 - Backend

API REST para reservacion de salas de reuniones de **Corporacion Millenium**.

## Stack

- Node.js + Express 5
- SQL Server (driver `mssql`)
- JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`)
- `cors`, `dotenv`, `express-validator`

## Estructura

```
src/
  config/db.js                 Pool de conexion a SQL Server
  middlewares/                 auth + roles
  controllers/                 auth, rooms, reservations
  routes/                      Routers por recurso
  utils/                       reply estandar y validacion de reservas
  app.js                       App Express
  server.js                    Entry point
db/scripts/01_init.sql         Script SQL (ejecutar manualmente)
scripts/generateHash.js        Genera hashes bcrypt para passwords
```

## Instalacion

```bash
npm install
cp .env.example .env   # ajustar credenciales si es necesario
```

## Arranque

```bash
npm run dev    # con nodemon
npm start      # produccion
```

El servidor levanta en `http://localhost:4000`. Si SQL Server no esta disponible logueara una advertencia pero seguira corriendo.

## Variables de entorno

| Variable        | Descripcion                                  |
|-----------------|----------------------------------------------|
| `PORT`          | Puerto HTTP del API (default 4000)           |
| `JWT_SECRET`    | Secreto para firmar tokens                   |
| `JWT_EXPIRES_IN`| Duracion del token (ej. `8h`)                |
| `DB_USER`       | Usuario SQL Server                           |
| `DB_PASSWORD`   | Password SQL Server                          |
| `DB_SERVER`     | Host                                         |
| `DB_DATABASE`   | Nombre de base (`TechnosoftRooms`)           |
| `DB_PORT`       | Puerto SQL Server (default 1433)             |
| `DB_ENCRYPT`    | `true` / `false`                             |
| `DB_TRUST_CERT` | `true` / `false`                             |
| `CORS_ORIGIN`   | Origen permitido (frontend Next, puerto 3000)|

## Base de datos

Antes de usar el API:

1. Tener una instancia de SQL Server corriendo (local o remota).
2. Ejecutar manualmente el script `db/scripts/01_init.sql`. Crea la base `TechnosoftRooms`, los schemas `auth` y `core`, las tablas, vista, indices y datos seed.
3. Confirmar que `.env` apunta a esa instancia.

### Credenciales por defecto

| Campo    | Valor                                        |
|----------|----------------------------------------------|
| Email    | `admin@millenium.cr`                         |
| Password | `Admin123!`                                  |
| Rol      | `admin`                                      |

> Cambiar la contrasena en produccion. Para generar un nuevo hash: `npm run hash -- 'MiNuevaPass'`.

## Endpoints

Todas las respuestas siguen el patron Millenium `{ ok, obj, msg }`.

### Autenticacion

| Metodo | Ruta                   | Acceso         | Descripcion                |
|--------|------------------------|----------------|----------------------------|
| POST   | `/api/auth/login`      | publico        | Devuelve token + user      |
| GET    | `/api/auth/me`         | autenticado    | Datos del token vigente    |
| POST   | `/api/auth/register`   | admin          | Crear usuario              |
| GET    | `/api/auth/users`      | admin          | Listar usuarios            |
| PATCH  | `/api/auth/users/:id/toggle` | admin    | Activar / desactivar       |

### Salas

| Metodo | Ruta              | Acceso       |
|--------|-------------------|--------------|
| GET    | `/api/rooms`      | autenticado  |
| GET    | `/api/rooms/:id`  | autenticado  |
| POST   | `/api/rooms`      | admin        |
| PUT    | `/api/rooms/:id`  | admin        |
| DELETE | `/api/rooms/:id`  | admin (soft) |

### Reservas

| Metodo | Ruta                          | Acceso              |
|--------|-------------------------------|---------------------|
| GET    | `/api/reservations?from&to&roomId` | autenticado    |
| GET    | `/api/reservations/mine`      | autenticado         |
| POST   | `/api/reservations`           | autenticado         |
| PUT    | `/api/reservations/:id`       | dueno / admin       |
| DELETE | `/api/reservations/:id`       | dueno / admin (cancela) |

## Reglas de reserva

1. No se puede reservar en el pasado.
2. No se puede solapar con otra reserva activa de la misma sala.
3. Maximo 30 dias a futuro.
4. Solo el creador o un admin pueden cancelar.
5. Duracion minima 15 min, maxima 4 horas.
6. Horario permitido 08:00 - 17:00 (mismo dia de inicio y fin).

## Prueba rapida

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@millenium.cr\",\"password\":\"Admin123!\"}"
```
