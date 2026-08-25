# Git workflow (v1.5.0 fix)

Cómo trabajar con este repo después del incidente de push directo
a master (2026-08-25).

## Reglas

1. **`master` está protegido.** No se pushea directamente. Se mergea
   vía PR desde una rama feature/*.
2. **`feature/*` ramas**: tracking a su rama remota homóloga
   (`origin/feature/<nombre>`), NUNCA a `origin/master`.
3. **Hook `pre-push`** rechaza pushes a `master`/`main` con un
   mensaje claro. Bypass de emergencia:
   `GIT_SKIP_PROTECTED_BRANCH_PUSH=1 git push ...`.
4. **Branch protection en GitHub** (settings → Branches) es la
   segunda capa. Aunque el hook falle (o el usuario use el bypass),
   GitHub rechaza el push si la regla está activa.

## Crear una rama feature nueva

```sh
git checkout origin/master            # o main, según la versión
git checkout -b feature/mi-cosa
git push -u origin feature/mi-cosa  # crea origin/feature/mi-cosa y
                                    # configura tracking correctamente
```

NO usar `git branch feature/x master` directamente — eso deja el
tracking apuntando a master y reproduce el bug que vimos.

## Mergear a master

Vía PR en GitHub. El botón "Merge" en la UI ya respeta las
reglas de protección.

## Si master se contaminó de nuevo

Si por algún motivo master recibe commits que no deberían estar
ahí:

### 1. Revertir localmente

```sh
# Marca el commit bueno en master (ej. fa4105a, justo antes de los
# commits no deseados)
git checkout master
git reset --hard <commit-bueno>
git push --force-with-lease origin master
```

`--force-with-lease` (no `--force`) verifica que el master remoto
no haya avanzado desde el último fetch; si alguien más pusheó
algo en medio, el push se aborta en vez de pisarlo.

### 2. Reaplicar trabajo perdido

Los commits siguen en `origin/feature/<rama>` o en
`refs/remotes/origin/master` antes del reset. Para recuperarlos:

```sh
git log --all --oneline | grep <patron>     # localizar los commits
git cherry-pick <sha>                      # reaplicar uno
```

## Limpieza tras el incidente del 2026-08-25

Esto ya está hecho en local (lo corrió opencode):

- ✅ `refs/remotes/origin/master` → `fa4105a` (v1.4.0 + plan, sin v1.5.0).
- ✅ `branch.feature/ingesta-s3-v1.5.0.merge` → `refs/heads/feature/ingesta-s3-v1.5.0`.
- ✅ Hook `pre-push` instalado en `.git/hooks/pre-push`.

Pendiente (requiere credenciales con write access al repo, que
opencode NO tiene):

- ⏳ `git push --force-with-lease origin fa4105a:master` desde la
  máquina donde el usuario tiene sus credenciales operativas.
- ⏳ `git push -u origin feature/ingesta-s3-v1.5.0` para crear la
  rama remota correcta.
- ⏳ Activar branch protection en GitHub:
  Settings → Branches → Add rule →
  Branch name pattern: `master`
  ☑ Require a pull request before merging
  ☑ Require approvals (al menos 1)
  ☑ Do not allow force pushes
  ☑ Do not allow deletions
  ☑ Require linear history (opcional)

## Verificar

```sh
# 1. master local y remoto coinciden en el commit bueno
git rev-parse master
git rev-parse origin/master
# ambos deben devolver el mismo SHA

# 2. feature branch tiene tracking correcto
git rev-parse --abbrev-ref feature/ingesta-s3-v1.5.0@{upstream}
# debe devolver origin/feature/ingesta-s3-v1.5.0

# 3. el hook rechaza push a master (debería fallar)
git push origin master
# → ERROR: refusing to push to protected branch 'master'.
```