resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = local.resource_prefix
  }

  depends_on = [terraform_data.account_guard]
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = local.resource_prefix
  }
}

resource "aws_subnet" "public" {
  for_each = {
    for index, availability_zone in var.availability_zones : availability_zone => {
      index = index
      cidr  = local.public_subnet_cidrs[index]
    }
  }

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = each.value.cidr
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.resource_prefix}-public-${each.value.index + 1}"
    Tier = "public-no-nat"
  }
}

resource "aws_subnet" "private" {
  for_each = {
    for index, availability_zone in var.availability_zones : availability_zone => {
      index = index
      cidr  = local.private_subnet_cidrs[index]
    }
  }

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = each.value.cidr
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.resource_prefix}-private-${each.value.index + 1}"
    Tier = "private-no-nat"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = {
    Name = "${local.resource_prefix}-public"
  }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${local.resource_prefix}-private"
  }
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  tags = {
    Name = "${local.resource_prefix}-s3"
  }
}

resource "aws_security_group" "planetscale_endpoint" {
  name        = "${local.resource_prefix}-planetscale-endpoint"
  description = "PlanetScale PrivateLink from Rend ECS tasks"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "planetscale_from_ecs" {
  description                  = "PlanetScale PostgreSQL from Rend ECS tasks"
  security_group_id            = aws_security_group.planetscale_endpoint.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.ecs.id
}

resource "aws_vpc_security_group_ingress_rule" "planetscale_pooled_from_ecs" {
  description                  = "PlanetScale pooled PostgreSQL from Rend ECS tasks"
  security_group_id            = aws_security_group.planetscale_endpoint.id
  ip_protocol                  = "tcp"
  from_port                    = 6432
  to_port                      = 6432
  referenced_security_group_id = aws_security_group.ecs.id
}

resource "aws_vpc_endpoint" "planetscale" {
  vpc_id              = aws_vpc.this.id
  service_name        = var.planetscale_vpc_endpoint_service_name
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for subnet in aws_subnet.private : subnet.id]
  security_group_ids  = [aws_security_group.planetscale_endpoint.id]

  tags = {
    Name = "${local.resource_prefix}-planetscale"
  }
}

data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "origin_alb" {
  name        = "${local.resource_prefix}-origin-alb"
  description = "CloudFront VPC Origin to the internal Rend ALB"
  vpc_id      = aws_vpc.this.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "public_api_alb" {
  name        = "${local.resource_prefix}-public-api-alb"
  description = "Public HTTPS ingress for the Rend API"
  vpc_id      = aws_vpc.this.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_vpc_security_group_ingress_rule" "public_api_ipv4" {
  description       = "Public HTTPS IPv4"
  security_group_id = aws_security_group.public_api_alb.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "public_api_ipv6" {
  description       = "Public HTTPS IPv6"
  security_group_id = aws_security_group.public_api_alb.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv6         = "::/0"
}

resource "aws_security_group" "ecs" {
  name        = "${local.resource_prefix}-ecs"
  description = "Rend API and edge traffic from the internal ALB"
  vpc_id      = aws_vpc.this.id

  egress {
    description = "PlanetScale, Tigris, AWS APIs, and package endpoints"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_vpc_security_group_ingress_rule" "origin_from_cloudfront" {
  description       = "HTTPS from the CloudFront origin-facing managed prefix list"
  security_group_id = aws_security_group.origin_alb.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
}

resource "aws_vpc_security_group_ingress_rule" "origin_from_ecs" {
  description                  = "HTTPS control and ClickHouse traffic from ECS tasks"
  security_group_id            = aws_security_group.origin_alb.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.ecs.id
}

resource "aws_vpc_security_group_ingress_rule" "ecs_from_origin" {
  description                  = "HTTPS to task-local TLS proxies from the internal ALB"
  security_group_id            = aws_security_group.ecs.id
  ip_protocol                  = "tcp"
  from_port                    = 8443
  to_port                      = 8443
  referenced_security_group_id = aws_security_group.origin_alb.id
}

resource "aws_vpc_security_group_ingress_rule" "ecs_from_public_api" {
  description                  = "HTTPS to API task-local TLS proxies from the public ALB"
  security_group_id            = aws_security_group.ecs.id
  ip_protocol                  = "tcp"
  from_port                    = 8443
  to_port                      = 8443
  referenced_security_group_id = aws_security_group.public_api_alb.id
}

resource "aws_security_group" "clickhouse" {
  name        = "${local.resource_prefix}-clickhouse"
  description = "ClickHouse is reachable only through the internal ALB"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "ClickHouse HTTP from the TLS-terminating internal ALB"
    from_port       = 8123
    to_port         = 8123
    protocol        = "tcp"
    security_groups = [aws_security_group.origin_alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
