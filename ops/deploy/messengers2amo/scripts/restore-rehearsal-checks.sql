-- Read-only exhaustive row check, including already VALID and NOT VALID FKs.
-- Merely VALIDATE CONSTRAINT is insufficient: it skips already-valid constraints.
SELECT set_config('rehearsal.schema', :'schema', false);
BEGIN READ ONLY;
DO $$
DECLARE fk record; joins text; present text; any_present text; missing boolean; checked integer := 0;
BEGIN
  FOR fk IN
    SELECT c.*, c.conrelid::regclass AS child, c.confrelid::regclass AS parent
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE c.contype='f' AND n.nspname=current_setting('rehearsal.schema')
  LOOP
    SELECT string_agg(format('p.%I = ch.%I',p.attname,a.attname),' AND ' ORDER BY k.i),
           string_agg(format('ch.%I IS NOT NULL',a.attname),' AND ' ORDER BY k.i),
           string_agg(format('ch.%I IS NOT NULL',a.attname),' OR ' ORDER BY k.i)
    INTO joins,present,any_present
    FROM generate_subscripts(fk.conkey,1) k(i)
    JOIN pg_attribute a ON a.attrelid=fk.conrelid AND a.attnum=fk.conkey[k.i]
    JOIN pg_attribute p ON p.attrelid=fk.confrelid AND p.attnum=fk.confkey[k.i];
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s ch WHERE ((%s) AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)) %s)',
      fk.child,present,fk.parent,joins,
      CASE WHEN fk.confmatchtype='f' THEN format('OR ((%s) AND NOT (%s))',any_present,present) ELSE '' END)
      INTO missing;
    IF missing THEN RAISE EXCEPTION 'orphan FK %.%',fk.child,fk.conname; END IF;
    checked := checked + 1;
  END LOOP;
  IF checked=0 THEN RAISE EXCEPTION 'no foreign keys checked'; END IF;
  RAISE NOTICE 'foreign_keys_checked=%',checked;
END $$;
COMMIT;
