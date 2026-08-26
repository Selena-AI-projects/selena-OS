-- The web runtime already has a projection grant on metric_snapshots from 0021.
-- PostgreSQL also requires schema USAGE before that table grant is reachable.
GRANT USAGE ON SCHEMA selena_performance TO selena_web_runtime;
