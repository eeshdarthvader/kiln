.DEFAULT_GOAL := run

IMAGE ?= localhost/sawd-exec-server:0.1.0
CONTAINER ?= sawd-exec-server
# Optional Docker flags, for example: -e AWS_PROFILE -v "$$HOME/.aws:/home/agent/.aws:ro"
RUN_ARGS ?=

.PHONY: build run stop test open

build:
	docker build --load -t "$(IMAGE)" .

run:
	@set -eu; \
	  containers="$$(docker container ls -a --format '{{.Names}}')"; \
	  for container in $$containers; do \
	    if [ "$$container" = "$(CONTAINER)" ]; then docker container rm -f "$$container"; fi; \
	  done
	docker run -d --rm --name "$(CONTAINER)" --env-file .env \
	  --health-cmd 'curl --fail --silent --max-time 2 "http://127.0.0.1:$${PORT:-3775}/readyz" >/dev/null' \
	  -p 127.0.0.1:3773:3773 -p 127.0.0.1:3775:3775 $(RUN_ARGS) \
	  --privileged --user root -e START_DOCKER=true "$(IMAGE)"

stop:
	docker stop "$(CONTAINER)"

test:
	npm run typecheck
	npm test
	npm run format:check
	python3 -B -m unittest discover -s tests -v
	@for script in image/*.sh setup.sh; do bash -n "$$script" || exit; done

open:
	python3 -m webbrowser http://localhost:3775
