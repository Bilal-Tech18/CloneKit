## Contexte de la cible (Vikunja, gestionnaire de tâches)
- **Périmètre** : la **vue liste d'un projet** (`/projects/:projectId/:viewId`), avec l'en-tête et la barre latérale telles qu'elles apparaissent sur les captures. Les autres pages (Overview, Upcoming, Labels…) ne sont pas dans le périmètre : leurs liens doivent exister (même nom, même URL) mais peuvent mener à une page vide.
- **Back** : l'API Vikunja est servie sous `/api/v1` par `server.mjs`, qui ajoute l'authentification. Le front l'appelle sans jeton. Les données sont réinitialisées avant chaque vérification : tu peux tester des écritures.
- Interroge l'API sur l'URL du front généré (ex. `curl -s http://localhost:4100/api/v1/projects`). L'original est un autre serveur : n'y télécharge ni HTML, ni JS, ni CSS.
- Rendu vérifié dans Chromium en 1280×800, langue en-US, fuseau UTC.
