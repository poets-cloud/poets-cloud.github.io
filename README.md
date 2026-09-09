# Poets Cloud Demo

This project builds a small, searchable poetry cloud demo based on the open MIT-licensed `chinese-poetry` dataset.

The public build is fully static: Vite packages the interface together with the chunked files in `data/web/`, so GitHub Pages does not need to run the Python API.

## Publish with GitHub Pages

Push the `main` branch to a GitHub repository, then select **Settings → Pages → Source: GitHub Actions**. The included workflow builds and publishes the site automatically after every push.

## Included data

- SQLite database at `data/poetry.db`
- Exported web data at `data/web/`
- Data quality report at `data/quality-report.json`

## Rebuild

```powershell
$env:PYTHONIOENCODING='utf-8'
python "scripts/build_poetry_database.py" --limit 2000
python "scripts/export_web_data.py"
python "scripts/verify_poetry_database.py"
```
