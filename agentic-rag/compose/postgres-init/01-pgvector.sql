-- Habilita extensión pgvector en la inicialización del cluster.
-- Se ejecuta una sola vez al crear el volumen (./postgres-init se monta
-- en /docker-entrypoint-initdb.d de la imagen oficial postgres).
CREATE EXTENSION IF NOT EXISTS vector;