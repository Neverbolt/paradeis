FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN DEBUG=1 python manage.py collectstatic --noinput \
    && groupadd --gid 10001 paradeis \
    && useradd --uid 10001 --gid paradeis --no-create-home paradeis \
    && mkdir -p /data \
    && chown -R paradeis:paradeis /data /app/staticfiles
USER paradeis
ENV DATABASE_PATH=/data/paradeis.sqlite3
EXPOSE 8000
CMD ["sh", "-c", "python manage.py migrate --noinput && exec gunicorn paradeis.wsgi:application --bind 0.0.0.0:8000 --workers 1 --threads 4 --timeout 45 --access-logfile - --error-logfile -"]
