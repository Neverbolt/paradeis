FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN DEBUG=0 ALLOWED_HOSTS=localhost \
    SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(64))')" \
    python manage.py collectstatic --noinput \
    && groupadd --gid 10001 paradeis \
    && useradd --uid 10001 --gid paradeis --no-create-home paradeis \
    && mkdir -p /data \
    && chown -R paradeis:paradeis /data /app/staticfiles
USER paradeis
ENV DATABASE_PATH=/data/paradeis.sqlite3
EXPOSE 8000
CMD ["python", "-m", "scripts.serve"]
