-- A live session check proves only that this authenticated screen reached the edge.
CREATE TABLE terminal_presence (
  terminal_id uuid PRIMARY KEY REFERENCES terminal_access_registry(terminal_id),
  generation integer NOT NULL CHECK (generation>0),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
