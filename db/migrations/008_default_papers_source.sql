-- Seed the default paper source for fresh deployments.

INSERT INTO sources (type, name)
SELECT 'papers', 'Hugging Face Daily Papers'
WHERE NOT EXISTS (
  SELECT 1
  FROM sources
  WHERE type = 'papers'
);
