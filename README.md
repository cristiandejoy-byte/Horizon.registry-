# Horizon · Service Registry

Microservicio de **registro y descubrimiento dinámico** para la arquitectura Horizon. Mantiene en memoria las instancias de cada microservicio, comprueba su salud con pings HTTP periódicos y elimina automáticamente las que dejan de responder.

- Node.js 20+ · Express 5 · Axios
- Sin base de datos: el registro vive en memoria (ver [limitaciones](#limitaciones-y-siguientes-pasos))
- Listo para Amazon ECS Fargate (`linux/amd64` y `linux/arm64`)
- Puerto por defecto: **8761**

---

## 1. Arquitectura

```
                    ┌──────────────────────────────┐
                    │   Service Registry :8761     │
   POST /register   │                              │
   ────────────────►│  Map<name|host|port, inst.>  │
   POST /heartbeat  │                              │
   ────────────────►│  ┌────────────────────────┐  │
   DELETE /unregister│  │ Health checker 10 s    │  │
   ────────────────►│  │  · TTL 30 s sin latido │  │
                    │  │  · GET healthPath      │  │
   GET /services    │  └────────────────────────┘  │
   ◄────────────────│                              │
   GET /services/x  └──────────────▲───────────────┘
   ◄────────────────                │ GET http://host:port/health
                                    │
              ┌─────────────────────┴─────────────────────┐
              │  gateway · Identity · Events · Channels   │
              │  Notifications · Flow · frontend · media  │
              └───────────────────────────────────────────┘
```

Flujo típico:

1. Al arrancar, cada microservicio hace `POST /register` con su nombre, host y puerto.
2. Cada 10 s (recomendado) envía `POST /heartbeat`; el registro también renueva la vida de la instancia si el `healthPath` responde 200.
3. Los consumidores consultan `GET /services/:name` y eligen una instancia `healthy`.
4. Al apagarse, el servicio llama `DELETE /unregister` (SIGTERM en ECS) para una baja limpia.
5. Si una instancia deja de responder o de enviar latidos durante 30 s, se elimina sola.

---

## 2. Estructura del proyecto

```
horizon.registry/
├── src/
│   ├── server.js                  # arranque, señales, health checker
│   ├── app.js                     # app Express (factory)
│   ├── config.js                  # validación de variables de entorno
│   ├── registry/store.js          # estado en memoria
│   ├── registry/health-checker.js # TTL + pings HTTP
│   ├── routes/registry.routes.js  # endpoints
│   └── lib/                       # errores, validación y logger
├── tests/store.test.js            # tests unitarios (node:test)
├── test-registry.js               # prueba de humo end-to-end
├── Dockerfile
├── .dockerignore
├── .env.example
└── README.md
```

---

## 3. Levantar en local

Requisitos: **Node.js 20 o superior** (probado con Node 22).

```bash
cd horizon.registry
npm install
cp .env.example .env      # opcional: los valores por defecto ya sirven
npm start                 # http://localhost:8761
```

Modo desarrollo con recarga automática:

```bash
npm run dev               # node --watch src/server.js
```

Comprobación rápida:

```bash
curl http://localhost:8761/health
curl http://localhost:8761/services
```

---

## 4. Docker

```bash
# Construir
docker build -t horizon-service-registry .

# Ejecutar
docker run --rm -p 8761:8761 \
  -e PORT=8761 \
  -e HEALTH_CHECK_INTERVAL_MS=10000 \
  -e INSTANCE_TTL_MS=30000 \
  horizon-service-registry

curl http://localhost:8761/health
```

### Multi-arquitectura (amd64 + arm64)

La imagen no tiene dependencias nativas, así que el mismo `Dockerfile` sirve para ambas arquitecturas. Para construir y publicar las dos a la vez:

```bash
docker buildx create --use --name horizon-builder   # solo la primera vez
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t <tu-registro>/horizon-service-registry:1.0.0 \
  --push .
```

En un Apple Silicon o en un runner ARM, `docker build` ya produce `linux/arm64`.

### Con `infra-horizon`

El servicio ya está añadido a `infra-horizon/docker-compose.yml`:

```bash
cd ../infra-horizon
docker compose up -d --build service-registry
docker compose logs -f service-registry
```

Dentro de esa red, el resto de contenedores lo alcanza en `http://service-registry:8761`.

---

## 5. Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `8761` | Puerto HTTP del registro |
| `HOST` | `0.0.0.0` | Interfaz de escucha (en contenedor debe ser `0.0.0.0`) |
| `HEALTH_CHECK_INTERVAL_MS` | `10000` | Cada cuánto se ejecuta el health checker |
| `INSTANCE_TTL_MS` | `30000` | Tiempo sin latido/ping correcto antes de eliminar la instancia. Debe ser **mayor** que el intervalo |
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | Timeout de cada ping HTTP |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` o `silent` |

La configuración se valida al arrancar: si un valor es inválido el proceso termina con un mensaje claro (fail-fast).

---

## 6. Endpoints

Formato de error uniforme:

```json
{ "error": { "code": "BAD_REQUEST", "message": "...", "details": {} } }
```

### `GET /health`

Salud del propio registro (para ECS/ALB):

```json
{
  "status": "ok",
  "service": "service-registry",
  "version": "1.0.0",
  "uptimeSeconds": 42,
  "registeredServices": 2,
  "registeredInstances": 3,
  "healthCheck": { "intervalMs": 10000, "instanceTtlMs": 30000, "timeoutMs": 2000 },
  "timestamp": "2026-11-23T10:00:00.000Z"
}
```

### `POST /register`

Registra una instancia. Si ya existe la misma combinación `name + host + port`, actualiza su `lastHeartbeat` y estado **sin duplicarla** y conserva su `id`.

```bash
curl -X POST http://localhost:8761/register \
  -H "Content-Type: application/json" \
  -d '{"name":"channels","host":"localhost","port":3001,"healthPath":"/health"}'
```

- `201 Created` en el primer registro.
- `200 OK` si actualiza una instancia existente.

Respuesta:

```json
{
  "id": "8f1c2a9e-6f3b-4a1e-9c2d-0b7f5e4d3a21",
  "name": "channels",
  "host": "localhost",
  "port": 3001,
  "url": "http://localhost:3001",
  "healthPath": "/health",
  "status": "healthy",
  "registeredAt": "2026-11-23T10:00:00.000Z",
  "updatedAt": "2026-11-23T10:00:00.000Z",
  "lastHeartbeat": "2026-11-23T10:00:00.000Z",
  "lastCheck": null,
  "lastCheckStatusCode": null,
  "lastCheckError": null
}
```

Validaciones: `name` en minúsculas (`a-z0-9-_`, hasta 63 caracteres), `host` sin `http://` ni rutas, `port` entero 1–65535, `healthPath` opcional (por defecto `/health`).

### `POST /heartbeat` o `PUT /heartbeat`

Renueva el registro:

```bash
curl -X POST http://localhost:8761/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"name":"channels","host":"localhost","port":3001}'
```

- `200 OK` con la instancia actualizada.
- `404 NOT_FOUND` si la instancia no está registrada (primero hay que registrarla).

### `DELETE /unregister`

Baja limpia al apagarse. Acepta el mismo body JSON o query string (útil si un proxy elimina el body de un `DELETE`):

```bash
curl -X DELETE http://localhost:8761/unregister \
  -H "Content-Type: application/json" \
  -d '{"name":"channels","host":"localhost","port":3001}'

curl -X DELETE "http://localhost:8761/unregister?name=channels&host=localhost&port=3001"
```

Respuesta:

```json
{
  "removed": true,
  "instance": { "id": "…", "name": "channels", "host": "localhost", "port": 3001, "…": "…" },
  "remainingInstances": 1
}
```

### `GET /services`

Todas las instancias agrupadas por nombre (incluye unhealthy para diagnóstico):

```json
{
  "services": {
    "channels": {
      "name": "channels",
      "instances": [
        {
          "id": "…",
          "name": "channels",
          "host": "localhost",
          "port": 3001,
          "url": "http://localhost:3001",
          "healthPath": "/health",
          "status": "healthy",
          "registeredAt": "…",
          "lastHeartbeat": "…",
          "lastCheck": "…",
          "lastCheckStatusCode": 200,
          "lastCheckError": null
        }
      ],
      "totalInstances": 1
    }
  },
  "totalServices": 1,
  "totalInstances": 1,
  "timestamp": "2026-11-23T10:00:00.000Z"
}
```

### `GET /services/:serviceName`

Solo las instancias **saludables** de un servicio, listas para descubrimiento:

```bash
curl http://localhost:8761/services/channels
```

```json
{
  "name": "channels",
  "instances": [
    { "id": "…", "host": "localhost", "port": 3001, "url": "http://localhost:3001", "status": "healthy", "lastHeartbeat": "…" },
    { "id": "…", "host": "localhost", "port": 3002, "url": "http://localhost:3002", "status": "healthy", "lastHeartbeat": "…" }
  ],
  "count": 2
}
```

- `404 SERVICE_NOT_FOUND` si el nombre no existe en el registro.
- `200` con `count: 0` y un `message` si el servicio existe pero ahora mismo no tiene instancias saludables (el cliente puede reintentar).

---

## 7. Ciclo de vida y estados

| Momento | Efecto |
|---|---|
| `POST /register` | Crea (o actualiza) la instancia como `healthy` con `lastHeartbeat = ahora` |
| `POST/PUT /heartbeat` | `healthy` + renueva `lastHeartbeat` |
| Health check 2xx | `healthy` + renueva `lastHeartbeat` (el latido explícito es opcional si el healthPath responde) |
| Health check fallido | `unhealthy`; no se borra hasta que expire el TTL |
| > `INSTANCE_TTL_MS` sin latido ni ping OK | Se **elimina** del registro |
| `DELETE /unregister` | Se elimina inmediatamente |

Recomendación para los clientes: enviar heartbeat cada **10 s** y usar un TTL de **30 s**, de modo que se toleren dos latidos perdidos.

---

## 8. Integración de los microservicios de Horizon

Todos los servicios deben:

1. Registrarse al arrancar (`POST /register`).
2. Renovar con heartbeat cada 10 s.
3. Darse de baja en el apagado (`SIGTERM` / `ApplicationStopping`).
4. Descubrir a los demás con `GET /services/:name`.

### Nombres y puertos sugeridos

Ajusta `healthPath` al endpoint real de cada servicio. `host` debe ser alcanzable **desde el contenedor del registro**: en local `localhost`, en ECS la IP privada de la tarea o el DNS de Cloud Map.

| Servicio | `name` | Puerto local | Puerto en contenedor | `healthPath` |
|---|---|---|---|---|
| API Gateway (YARP) | `gateway` | 5181 | 8080 | `/health` |
| Identity API (.NET) | `identity` | 5005 | 8080 | `/health` |
| Events API | `events` | 5006 | 8080 | `/health` |
| Channels | `channels` | 3001 | 3001 | `/health` |
| Notifications | `notifications` | 5007 | 8080 | `/health` |
| Flow | `flow` | 3003 | 3003 | `/health` |
| Frontend (Next.js) | `frontend` | 3000 | 3000 | `/api/health` |
| Media server (nginx-rtmp) | `media` | 8080 | 80 | `/stat` |

> Añade un endpoint de salud real a cada servicio (por ejemplo `/health` que devuelva `200` y `{ "status": "ok" }`). Si un servicio no expone health, el registro lo marcará `unhealthy` y dejará de aparecer en `GET /services/:name`.

### Cliente Node.js (registro + heartbeat + baja)

```js
import axios from 'axios';

const REGISTRY_URL = process.env.SERVICE_REGISTRY_URL ?? 'http://localhost:8761';
const SELF = {
  name: 'channels',
  host: process.env.SERVICE_HOST ?? 'localhost', // en ECS: IP privada / DNS
  port: Number(process.env.PORT ?? 3001),
  healthPath: '/health',
};

export async function registerInRegistry() {
  await axios.post(`${REGISTRY_URL}/register`, SELF);
}

export function startHeartbeat() {
  return setInterval(() => {
    axios.post(`${REGISTRY_URL}/heartbeat`, SELF).catch((error) => {
      console.warn('[registry] heartbeat fallido:', error.message);
    });
  }, 10_000);
}

export async function unregisterFromRegistry() {
  await axios.delete(`${REGISTRY_URL}/unregister`, { data: SELF }).catch(() => {});
}
```

### Cliente C# (.NET 8, para Identity / Gateway)

```csharp
public sealed class ServiceRegistryClient(HttpClient http)
{
    private readonly string _baseUrl =
        Environment.GetEnvironmentVariable("SERVICE_REGISTRY_URL") ?? "http://localhost:8761";

    public Task RegisterAsync(string name, string host, int port) =>
        http.PostAsJsonAsync($"{_baseUrl}/register",
            new { name, host, port, healthPath = "/health" });

    public Task HeartbeatAsync(string name, string host, int port) =>
        http.PostAsJsonAsync($"{_baseUrl}/heartbeat", new { name, host, port });

    public async Task<string[]> DiscoverAsync(string name)
    {
        var response = await http.GetFromJsonAsync<DiscoveryResponse>(
            $"{_baseUrl}/services/{name}");
        return response?.Instances.Select(i => i.Url).ToArray() ?? [];
    }

    private sealed record DiscoveryResponse(InstanceDto[] Instances);
    private sealed record InstanceDto(string Url);
}
```

Y en `Program.cs`, con `IHostApplicationLifetime`:

```csharp
app.Lifetime.ApplicationStarted.Register(() =>
    registry.RegisterAsync("identity", host, port).GetAwaiter().GetResult());

app.Lifetime.ApplicationStopping.Register(() =>
    registry.UnregisterAsync("identity", host, port).GetAwaiter().GetResult());
```

### Descubrimiento con balanceo simple

```js
async function discover(serviceName) {
  const { data } = await axios.get(`${REGISTRY_URL}/services/${serviceName}`);
  if (data.count === 0) throw new Error(`Sin instancias de ${serviceName}`);

  const instance = data.instances[Math.floor(Math.random() * data.instances.length)];
  return instance.url; // p. ej. http://channels-1:3001
}
```

El frontend debe consultar el registro a través del **gateway** o desde un Route Handler de Next.js; no se expone CORS por defecto.

---

## 9. Pruebas

### Prueba de humo (end-to-end)

```bash
npm test
```

`test-registry.js` levanta dos instancias reales del servicio (una normal y otra con TTL corto) y dos servicios simulados con `/health`, y comprueba:

- `/health` y `/services` vacío
- registro de `gateway` y **dos instancias de `channels`**
- registro duplicado (mismo `id`, sin duplicar)
- agrupación de `/services` y descubrimiento en `/services/channels`
- `404` de servicio desconocido
- renovación con `PUT` y `POST /heartbeat`, y `404` de instancia desconocida
- validaciones `400` (payload inválido y JSON roto) y ruta `404`
- baja con `DELETE /unregister` (body y query string)
- instancia con health inaccesible → `unhealthy`
- **expiración automática por TTL**, manteniendo viva la instancia que responde health

### Tests unitarios del store

```bash
npm run test:unit
```

Cubren duplicados, normalización, TTL, heartbeats, unregister y filtrado healthy.

---

## 10. Despliegue en Amazon ECS (Fargate)

### Imagen

```bash
docker buildx build --platform linux/arm64 \
  -t <cuenta>.dkr.ecr.<region>.amazonaws.com/horizon-service-registry:1.0.0 --push .
```

### Task definition (resumen)

```json
{
  "family": "horizon-service-registry",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "runtimePlatform": {
    "operatingSystemFamily": "LINUX",
    "cpuArchitecture": "ARM64"
  },
  "containerDefinitions": [
    {
      "name": "service-registry",
      "image": "<cuenta>.dkr.ecr.<region>.amazonaws.com/horizon-service-registry:1.0.0",
      "essential": true,
      "portMappings": [{ "containerPort": 8761, "protocol": "tcp" }],
      "environment": [
        { "name": "PORT", "value": "8761" },
        { "name": "HEALTH_CHECK_INTERVAL_MS", "value": "10000" },
        { "name": "INSTANCE_TTL_MS", "value": "30000" }
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "wget -qO- http://127.0.0.1:8761/health > /dev/null || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 10
      },
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/horizon-service-registry",
          "awslogs-region": "<region>",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

Notas para Fargate:

- ECS **no usa el `HEALTHCHECK` del Dockerfile**: el health check debe declararse en la task definition (arriba) o en el Target Group del ALB.
- Target Group / ALB: ruta `/health`, matcher `200`, intervalo 30 s.
- Mantén **desired count = 1**: el estado es en memoria y varias tareas tendrían registros distintos.
- Para que las tareas se alcancen entre sí: usa la **IP privada** de la tarea o **Cloud Map** (`channels.horizon.local:3001`); `localhost` dentro de una tarea apunta al propio contenedor, no a los demás.
- Los servicios deben recibir `SERVICE_REGISTRY_URL=http://service-registry:8761` (o el DNS del ALB interno) para registrarse.
- Asigna a la tarea el rol de ejecución necesario para leer de ECR y escribir en CloudWatch Logs.

---

## 11. Limitaciones y siguientes pasos

- **Estado en memoria**: se pierde al reiniciar y no se comparte entre réplicas. Para producción multi-réplica habría que persistir en Redis o DynamoDB.
- **Sin autenticación**: cualquier cliente de la red puede registrar instancias. En producción, restringe el security group / ALB interno o añade un token compartido.
- **Sin CORS**: el gateway es la puerta pública; el frontend no debe llamar al registro desde el navegador.
- **Sin métricas Prometheus ni trazas**: candidato natural para una siguiente iteración.
- **`unhealthy` no se borra de inmediato**: se conserva para diagnóstico hasta que expira el TTL de 30 s.

---

## 12. Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `404` en `/heartbeat` | La instancia nunca se registró o expiró | Llamar antes a `POST /register`; revisar que `host` y `port` coincidan exactamente |
| Un servicio no aparece en `GET /services/:name` | Está `unhealthy` o no tiene latidos recientes | Revisar `lastCheckError` en `GET /services`; comprobar el `healthPath` |
| `EADDRINUSE` al arrancar | Otro proceso usa el puerto 8761 | Cambiar `PORT` o liberar el puerto |
| En ECS no se alcanzan las instancias | Se registró `localhost` | Registrar la IP privada de la tarea o el DNS de Cloud Map |
| La instancia desaparece cada ~30 s | No se envía heartbeat y el healthPath falla | Enviar heartbeat cada 10 s o corregir el endpoint de salud |
| El registro se reinicia y todo se pierde | Estado en memoria | Esperado; para persistencia, integrar Redis/DynamoDB |

---

## 13. Referencias rápidas

```bash
# Local
npm install && npm start

# Tests
npm test
npm run test:unit

# Docker
docker build -t horizon-service-registry .
docker run --rm -p 8761:8761 horizon-service-registry

# Endpoints
GET    /health
POST   /register
POST   /heartbeat   (también PUT)
DELETE /unregister
GET    /services
GET    /services/:serviceName
```
