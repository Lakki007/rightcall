# RightCall release image. Build:  docker build -t rightcall:1.1.0 .   Run:  docker run -p 8000:8000 rightcall:1.1.0
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend backend
COPY static static
COPY samples samples
RUN useradd -m app && mkdir -p /data && chown app /data
USER app
ENV HOST=0.0.0.0 PORT=8000 RIGHTCALL_DB=/data/rightcall.db
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/health',timeout=4)"
CMD ["python", "backend/server.py"]
