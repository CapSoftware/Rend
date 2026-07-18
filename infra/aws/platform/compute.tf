resource "aws_ecs_cluster" "this" {
  name = local.resource_prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 1
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(["api", "edge", "worker"])

  name              = "/rend/${var.environment}/${each.value}"
  retention_in_days = var.log_retention_days
}

resource "aws_lb" "origin" {
  name               = substr("${local.resource_prefix}-origin", 0, 32)
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.origin_alb.id]
  subnets            = [for subnet in aws_subnet.private : subnet.id]

  enable_deletion_protection = true
  drop_invalid_header_fields = true
  idle_timeout               = 60
}

resource "aws_lb" "public_api" {
  name               = substr("${local.resource_prefix}-api-public", 0, 32)
  internal           = false
  load_balancer_type = "application"
  ip_address_type    = "ipv4"
  security_groups    = [aws_security_group.public_api_alb.id]
  subnets            = [for subnet in aws_subnet.public : subnet.id]

  enable_deletion_protection = true
  drop_invalid_header_fields = true
  idle_timeout               = 120
}

resource "aws_lb_target_group" "api" {
  name        = substr("${local.resource_prefix}-api", 0, 32)
  port        = 8443
  protocol    = "HTTPS"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  deregistration_delay = 30

  health_check {
    enabled             = true
    protocol            = "HTTPS"
    path                = "/readyz"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

resource "aws_lb_target_group" "public_api" {
  name        = substr("${local.resource_prefix}-api-public", 0, 32)
  port        = 8443
  protocol    = "HTTPS"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  deregistration_delay = 30

  health_check {
    enabled             = true
    protocol            = "HTTPS"
    path                = "/readyz"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

resource "aws_lb_target_group" "edge" {
  name        = substr("${local.resource_prefix}-edge", 0, 32)
  port        = 8443
  protocol    = "HTTPS"
  target_type = "ip"
  vpc_id      = aws_vpc.this.id

  deregistration_delay = 30

  health_check {
    enabled             = true
    protocol            = "HTTPS"
    path                = "/readyz"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

resource "aws_lb_target_group" "clickhouse" {
  name        = substr("${local.resource_prefix}-clickhouse", 0, 32)
  port        = 8123
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = aws_vpc.this.id

  health_check {
    enabled             = true
    path                = "/ping"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

resource "aws_lb_target_group_attachment" "clickhouse" {
  target_group_arn = aws_lb_target_group.clickhouse.arn
  target_id        = aws_instance.clickhouse.id
  port             = 8123
}

resource "aws_lb_listener" "internal_https" {
  load_balancer_arn = aws_lb.origin.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.internal.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "public_api_https" {
  load_balancer_arn = aws_lb.public_api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.public.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.public_api.arn
  }
}

resource "aws_lb_listener_rule" "edge_https" {
  listener_arn = aws_lb_listener.internal_https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.edge.arn
  }

  condition {
    path_pattern {
      values = [
        "/v/*",
        "/embed-fast/*",
        "/internal/warm",
        "/internal/purge",
      ]
    }
  }
}

resource "aws_lb_listener_rule" "clickhouse_https" {
  listener_arn = aws_lb_listener.internal_https.arn
  priority     = 5

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.clickhouse.arn
  }

  condition {
    host_header {
      values = [local.clickhouse_internal_domain]
    }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.resource_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  skip_destroy             = true
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "rend-api"
    image     = var.api_image
    essential = true
    environment = concat(local.common_container_environment, [
      { name = "REND_SERVICE_NAME", value = "rend-api" },
      { name = "REND_API_BIND_ADDR", value = "127.0.0.1:4000" },
      { name = "REND_API_AUTO_MIGRATE", value = "false" },
      { name = "REND_API_INLINE_MEDIA_PROCESSING", value = "false" },
      { name = "REND_API_BASE_URL", value = local.api_base_url },
      { name = "REND_PUBLIC_API_BASE_URL", value = local.api_base_url },
      { name = "REND_API_CORS_ALLOWED_ORIGINS", value = local.allowed_origins },
      { name = "REND_PLAYBACK_COOKIE_DOMAIN", value = var.playback_cookie_domain },
    ])
    secrets = local.api_container_secrets
    healthCheck = {
      command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:4000/readyz || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["api"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
    },
    {
      name       = "tls-proxy"
      image      = var.tls_proxy_image
      essential  = true
      entryPoint = ["/bin/sh", "-c"]
      command = [<<-EOT
        printf '{\n  auto_https disable_redirects\n  admin off\n  default_sni localhost\n  fallback_sni localhost\n}\nhttps://localhost:8443, https://:8443 {\n  tls internal\n  reverse_proxy 127.0.0.1:4000\n}\n' >/tmp/Caddyfile
        exec caddy run --config /tmp/Caddyfile --adapter caddyfile
      EOT
      ]
      portMappings = [{
        name          = "https"
        containerPort = 8443
        hostPort      = 8443
        protocol      = "tcp"
      }]
      dependsOn = [{
        containerName = "rend-api"
        condition     = "HEALTHY"
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service["api"].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "tls"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.resource_prefix}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  skip_destroy             = true
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "rend-api"
    image     = var.api_image
    essential = true
    command   = ["migrate"]
    environment = concat(local.common_container_environment, [
      { name = "REND_SERVICE_NAME", value = "rend-api-migrate" },
      { name = "REND_API_AUTO_MIGRATE", value = "false" },
      { name = "REND_API_INLINE_MEDIA_PROCESSING", value = "false" },
    ])
    secrets = local.api_container_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["api"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "edge" {
  family                   = "${local.resource_prefix}-edge"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  skip_destroy             = true
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  ephemeral_storage {
    size_in_gib = 50
  }

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "rend-edge"
    image     = var.edge_image
    essential = true
    environment = concat(local.common_container_environment, [
      { name = "REND_SERVICE_NAME", value = "rend-edge" },
      { name = "REND_EDGE_BIND_ADDR", value = "127.0.0.1:4100" },
      { name = "REND_EDGE_ID", value = local.edge_id },
      { name = "REND_EDGE_REGION", value = local.edge_region },
      { name = "REND_EDGE_BASE_URL", value = local.playback_base_url },
      { name = "REND_EDGE_CORS_ALLOWED_ORIGINS", value = local.allowed_origins },
      { name = "REND_CONTROL_PLANE_URL", value = local.internal_base_url },
      { name = "REND_EDGE_FAST_EMBED_CONTROL_PLANE_URL", value = local.internal_base_url },
      { name = "REND_EDGE_FAST_EMBED_CACHE_TTL_SECS", value = "60" },
      { name = "REND_EDGE_HEARTBEAT_INTERVAL_SECS", value = "15" },
      { name = "REND_EDGE_CACHE_MAX_BYTES", value = "32212254720" },
      # CloudFront carries normal cache hits. On an origin miss, the edge
      # reauthorizes disk bytes through the API without a Tigris HEAD.
      { name = "REND_EDGE_VALIDATE_CACHE_ORIGIN", value = "false" },
      { name = "REND_EDGE_ARTIFACT_RESOLUTION_CACHE_TTL_SECS", value = "300" },
      { name = "REND_EDGE_ARTIFACT_RESOLUTION_CACHE_MAX_ENTRIES", value = "10000" },
      { name = "REND_EDGE_ASSET_AVAILABILITY_CACHE_TTL_SECS", value = "5" },
      { name = "REND_EDGE_CACHE_MIN_FREE_BYTES", value = "5368709120" },
      { name = "REND_EDGE_CACHE_DIR", value = "/var/lib/rend/edge-cache" },
      { name = "REND_EDGE_ORIGIN_HEALTH_URL", value = var.tigris_endpoint },
      { name = "REND_EDGE_MAX_IN_FLIGHT_FILLS", value = "64" },
      { name = "REND_EDGE_MAX_ORIGIN_ARTIFACT_BYTES", value = "53687091200" },
      { name = "REND_EDGE_TELEMETRY_ENABLED", value = "true" },
      { name = "REND_EDGE_TELEMETRY_INGEST_URL", value = "${local.internal_base_url}/internal/telemetry/playback" },
      { name = "REND_EDGE_TELEMETRY_QUEUE_CAPACITY", value = "4096" },
      { name = "REND_EDGE_TELEMETRY_BATCH_SIZE", value = "100" },
      { name = "REND_EDGE_TELEMETRY_FLUSH_INTERVAL_SECS", value = "2" },
      { name = "REND_EDGE_TELEMETRY_REQUEST_TIMEOUT_SECS", value = "2" },
      { name = "REND_EDGE_TELEMETRY_SPOOL_DIR", value = "/var/spool/rend/edge-telemetry" },
      { name = "REND_EDGE_TELEMETRY_SPOOL_MAX_BYTES", value = "1073741824" },
    ])
    secrets = local.edge_container_secrets
    healthCheck = {
      command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:4100/readyz || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["edge"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
    },
    {
      name       = "tls-proxy"
      image      = var.tls_proxy_image
      essential  = true
      entryPoint = ["/bin/sh", "-c"]
      command = [<<-EOT
        printf '{\n  auto_https disable_redirects\n  admin off\n  default_sni localhost\n  fallback_sni localhost\n}\nhttps://localhost:8443, https://:8443 {\n  tls internal\n  reverse_proxy 127.0.0.1:4100\n}\n' >/tmp/Caddyfile
        exec caddy run --config /tmp/Caddyfile --adapter caddyfile
      EOT
      ]
      portMappings = [{
        name          = "https"
        containerPort = 8443
        hostPort      = 8443
        protocol      = "tcp"
      }]
      dependsOn = [{
        containerName = "rend-edge"
        condition     = "HEALTHY"
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service["edge"].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "tls"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.resource_prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "4096"
  memory                   = "8192"
  skip_destroy             = true
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  ephemeral_storage {
    size_in_gib = 100
  }

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "rend-media-worker"
    image     = var.worker_image
    essential = true
    environment = concat(local.common_container_environment, [
      { name = "REND_SERVICE_NAME", value = "rend-media-worker" },
      { name = "REND_API_AUTO_MIGRATE", value = "false" },
      { name = "REND_API_INLINE_MEDIA_PROCESSING", value = "false" },
    ])
    secrets     = local.common_container_secrets
    stopTimeout = 120
    healthCheck = {
      command     = ["CMD-SHELL", "tr '\\0' ' ' </proc/1/cmdline | grep -q 'worker media'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["worker"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.services_enabled ? var.api_min_tasks : 0

  enable_ecs_managed_tags           = true
  enable_execute_command            = true
  propagate_tags                    = "SERVICE"
  wait_for_steady_state             = true
  health_check_grace_period_seconds = 60

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 1
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = true
    security_groups  = [aws_security_group.ecs.id]
    subnets          = [for subnet in aws_subnet.public : subnet.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "tls-proxy"
    container_port   = 8443
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.public_api.arn
    container_name   = "tls-proxy"
    container_port   = 8443
  }

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }

  depends_on = [
    aws_lb_listener.internal_https,
    aws_lb_listener.public_api_https,
    terraform_data.service_activation_guard,
  ]
}

resource "aws_ecs_service" "edge" {
  name            = "edge"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.edge.arn
  desired_count   = var.services_enabled ? var.edge_min_tasks : 0

  enable_ecs_managed_tags           = true
  enable_execute_command            = true
  propagate_tags                    = "SERVICE"
  wait_for_steady_state             = true
  health_check_grace_period_seconds = 90

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 1
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = true
    security_groups  = [aws_security_group.ecs.id]
    subnets          = [for subnet in aws_subnet.public : subnet.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.edge.arn
    container_name   = "tls-proxy"
    container_port   = 8443
  }

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }

  depends_on = [aws_lb_listener_rule.edge_https, terraform_data.service_activation_guard]
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.services_enabled ? var.worker_min_tasks : 0

  enable_ecs_managed_tags = true
  enable_execute_command  = true
  propagate_tags          = "SERVICE"
  wait_for_steady_state   = true

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 1
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = true
    security_groups  = [aws_security_group.ecs.id]
    subnets          = [for subnet in aws_subnet.public : subnet.id]
  }

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }
}

resource "aws_appautoscaling_target" "ecs" {
  for_each = {
    api = {
      service = aws_ecs_service.api.name
      min     = var.api_min_tasks
      max     = var.api_max_tasks
    }
    edge = {
      service = aws_ecs_service.edge.name
      min     = var.edge_min_tasks
      max     = var.edge_max_tasks
    }
    worker = {
      service = aws_ecs_service.worker.name
      min     = var.worker_min_tasks
      max     = var.worker_max_tasks
    }
  }

  max_capacity       = each.value.max
  min_capacity       = var.services_enabled ? each.value.min : 0
  resource_id        = "service/${aws_ecs_cluster.this.name}/${each.value.service}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
  tags               = local.common_tags

  suspended_state {
    dynamic_scaling_in_suspended  = !var.services_enabled
    dynamic_scaling_out_suspended = !var.services_enabled
    scheduled_scaling_suspended   = !var.services_enabled
  }
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = var.services_enabled ? aws_appautoscaling_target.ecs : {}

  name               = "${local.resource_prefix}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = each.key == "worker" ? 70 : 60
    scale_in_cooldown  = each.key == "worker" ? 300 : 120
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "worker_queue" {
  count = var.services_enabled ? 1 : 0

  name               = "${local.resource_prefix}-worker-queue"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs["worker"].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs["worker"].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs["worker"].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 1
    scale_in_cooldown  = 300
    scale_out_cooldown = 30

    customized_metric_specification {
      metric_name = "QueuedJobsPerWorker"
      namespace   = "Rend/Media"
      statistic   = "Average"

      dimensions {
        name  = "Environment"
        value = var.environment
      }
    }
  }
}
